import { GoogleGenAI } from "@google/genai";
import { v4 as uuid } from "uuid";
import fsp from "node:fs/promises";
import path from "node:path";
import { FlowStore } from "./flow-store";
import { DescriptionStore, type DescriptionDocument } from "./description-store";
import { FlowEvaluator, type NewlyDetectedFlow } from "./evaluator";
import { WorthJudge, type FlowForJudgment, type WorthVerdict } from "./worth-judge";
import { GapCloser, extractQuestions, insertAnswersAndRewriteQuestions } from "./gap-closer";
import { PartialElevator } from "./partial-elevator";
import { BodyRefiner } from "./body-refiner";
import { ParamExtractor } from "./param-extractor";
import { loadConfig } from "../config";
import { getEffectiveSettings } from "../ai/mode-presets";
import type {
  DetectionResult,
  EvaluatorResult,
  FlowDocument,
  FlowFrontmatter,
  KnowledgeFrontmatter,
} from "../types";

const DETECTION_PROMPT = `You are FlowMind, an AI that analyzes detailed narrative descriptions of user activity to detect repeated workflows, behavioral patterns, and decision-making knowledge.

You will receive a series of short narrative descriptions (each covering roughly one minute of activity), concatenated in chronological order. Read them together as one continuous story and detect patterns across the whole span.

Produce a JSON response with detected flows and knowledge.

CLASSIFICATION CRITERIA — follow these strictly:

COMPLETE FLOW — ALL of these must be true:
- A multi-step sequence (3+ distinct, meaningful steps) with a clear beginning and end
- Steps have enough detail to be reproduced by someone else
- Decision logic is observable (not guessed or hedged with "potentially"/"might")
- The flow involves purposeful work, not just opening/closing apps or browsing

PARTIAL FLOW — use when:
- You see a meaningful multi-step sequence but some steps are unclear or missing
- You can identify gaps that need clarification from the user
- Mark gaps with [GAP] and provide specific questions to fill them

KNOWLEDGE FRAGMENT — use for everything else:
- Single observations, habits, preferences, tool usage patterns
- Simple actions like "user opened app X" or "user watched a video"
- Behavioral patterns that are not actionable workflows
- One-time activities or browsing/exploration behavior

IMPORTANT:
- Do NOT mark a flow as "complete" if you are guessing or hedging any steps
- A single activity (watching a video, checking email) is a knowledge fragment, NOT a flow
- Be SPECIFIC — reference actual app names, window titles, and actions mentioned in the narratives
- Never include sensitive data (passwords, tokens, personal message content)
- A single flow may span multiple narrative windows — stitch them together when they continue naturally
- MERGE adjacent windows: when the same activity spans two or more consecutive windows (e.g., an action started in window N and finished in window N+1), treat it as ONE flow, not multiple. Never emit two flows that describe the same underlying activity.
- COMPREHENSIVE DETECTION: when the narratives describe a multi-step task that ends in a concrete outcome (a file saved, a message sent, a form submitted), include ALL steps from the triggering action through the outcome in a SINGLE flow. Do NOT truncate the flow at a familiar sub-sequence (e.g., "searching Wikipedia") and ignore later steps (e.g., "copying the content and saving it to a notes file"). The flow should cover the full task the user was trying to accomplish.
- PARTIAL-TO-COMPLETE CHECK: before emitting a partial flow, scan ALL later windows in the input. If a later window shows the same user/subject/goal reaching a concrete outcome (a file saved, a message sent, a form submitted) — even after an intervening "search struggle" or multi-attempt detour — emit a COMPLETE flow covering the whole sequence (search → retries → eventual outcome) instead of a partial. A flow is only partial if NO later window shows the outcome being reached. The iterative search + retry pattern is not a sign of a partial flow; it is a common variation of a complete flow that should be described in the "Variations Observed" section.
- ITERATIVE-SEARCH PATTERN: when the user performs several search attempts (refining queries, switching search engines, scrolling results) before reaching the intended information, treat the whole search+retry sequence as ONE step group of the larger flow. Do not split this into multiple flows. Note the retry behaviour in "Variations Observed".
- REPEATED-PATTERN INSTANCES: if the same complete-flow pattern repeats for a different subject within a single capture (e.g., the user does the "research subject X → save notes" workflow twice, once for subject A and once for subject B), emit ONE complete_flow entry that covers the pattern. Do not emit two identical complete flows. The repeated subjects go into "Variations Observed" as evidence of parameterisation.
- EXCLUDE the FlowMind app itself from flow detection. FlowMind is the observer — do NOT include "the user opened FlowMind", "clicked Start Capture", "stopped Capture", "viewed the Dashboard", or any interaction with the FlowMind Electron app as a step in a flow or as a knowledge fragment. If the ONLY activity in a window was FlowMind itself, return nothing for that window. You MAY still mention FlowMind usage in descriptions, but the flow detector must treat it as invisible.
- Some windows include "key visual frames" — screenshots the describe phase preserved because the text alone was insufficient. Use those images to verify exact button labels, error messages, UI state, and specific content that the narrative may have summarized.
- If the narratives describe mostly idle or no meaningful patterns, return empty arrays

SOURCE WINDOWS — for each flow and each knowledge fragment, list the EXACT windowStart timestamps (copied character-for-character from the "## Window <start> → <end>" headers in the input) that contributed to it. This is a derivative of the work you just did, not a separate task — just cite the windows you used. Include every window that provided evidence. If a knowledge fragment came from one window, that's fine — list just that one.

Respond with ONLY valid JSON in this exact format:
{
  "complete_flows": [
    {
      "name": "Human-readable flow name",
      "confidence": "high" | "medium",
      "avg_duration_minutes": number,
      "trigger": "what starts this flow",
      "apps": ["app1", "app2"],
      "steps": "Full markdown steps section (use IF/ELSE, FOR EACH where appropriate)",
      "decision_logic": "Markdown section describing decision conditions",
      "tools_and_data": "Markdown section describing tool usage",
      "automation_classification": "Markdown section classifying step types",
      "variations": "Markdown section noting variations",
      "source_windows": ["<windowStart ISO>", "..."]
    }
  ],
  "partial_flows": [
    {
      "name": "Human-readable flow name",
      "confidence": "low" | "medium",
      "apps": ["app1"],
      "observed_steps": "Markdown with observed steps, [GAP] markers",
      "questions": ["Q1: specific question", "Q2: specific question"],
      "best_guess": "What you think the complete flow looks like",
      "source_windows": ["<windowStart ISO>", "..."]
    }
  ],
  "knowledge": [
    {
      "title": "Observation title",
      "category": "decision-pattern" | "habit" | "preference" | "tool-usage",
      "apps": ["app1"],
      "observation": "What was observed",
      "significance": "Why this matters for automation",
      "related_flows": ["flow name if related"],
      "source_windows": ["<windowStart ISO>", "..."]
    }
  ]
}`;

export class FlowDetectionEngine {
  private store: FlowStore;
  private descriptionStore: DescriptionStore;
  private genai: GoogleGenAI;
  private evaluator: FlowEvaluator;
  private worthJudge: WorthJudge;
  private gapCloser: GapCloser;
  private partialElevator: PartialElevator;
  private bodyRefiner: BodyRefiner;
  private paramExtractor: ParamExtractor;
  private running = false;

  constructor(store: FlowStore, descriptionStore: DescriptionStore) {
    this.store = store;
    this.descriptionStore = descriptionStore;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    this.genai = new GoogleGenAI({ apiKey });
    this.evaluator = new FlowEvaluator();
    this.worthJudge = new WorthJudge();
    this.gapCloser = new GapCloser();
    this.partialElevator = new PartialElevator();
    this.bodyRefiner = new BodyRefiner();
    this.paramExtractor = new ParamExtractor();
  }

  isRunning(): boolean {
    return this.running;
  }

  async detectFlows(): Promise<DetectionResult> {
    if (this.running) {
      throw new Error("Detection already in progress");
    }
    this.running = true;

    try {
      const config = await loadConfig();
      const settings = getEffectiveSettings(config);

      const emptyResult: DetectionResult = {
        newComplete: 0, updatedComplete: 0, newPartial: 0, newKnowledge: 0, filesWritten: [],
      };

      // 1. Load unanalyzed descriptions
      const descriptions = await this.descriptionStore.getUnanalyzedDescriptions();
      if (descriptions.length === 0) {
        console.log(`[Detection] No unanalyzed descriptions — skipping`);
        return emptyResult;
      }

      console.log(`[Detection] Analyzing ${descriptions.length} descriptions`);

      // 2. Build interleaved multimodal parts: each window's narrative followed by
      //    its key screenshots (if any), in chronological order.
      const windowParts = await this.buildWindowParts(descriptions);
      const totalKeyFrames = windowParts.reduce((sum, w) => sum + w.keyScreenshots.length, 0);
      console.log(`[Detection] Including ${totalKeyFrames} key screenshots across ${descriptions.length} windows`);

      // 3. Single Gemini call (text + key screenshots only)
      const analysis = await this.analyzeWithGemini(settings.detectionModel, windowParts, settings.thinking);

      // 3b. Partial elevator — for each partial just emitted by phase 2, ask
      //     the model whether a LATER window in this same run shows the
      //     outcome being reached. If yes, replace the partial with a
      //     complete flow covering the whole sequence. This fixes the case
      //     where phase 2 cuts a flow too early at the "search struggle"
      //     portion and misses the later save/outcome.
      if ((analysis.partial_flows ?? []).length > 0) {
        const verdicts = await this.partialElevator.elevateAll(
          analysis.partial_flows ?? [],
          descriptions,
          settings.detectionModel
        );
        const elevatedCompletes: typeof analysis.complete_flows = [];
        const survivingPartials: typeof analysis.partial_flows = [];
        const original = analysis.partial_flows ?? [];
        for (let i = 0; i < original.length; i++) {
          const v = verdicts[i];
          if (v && v.elevate) {
            elevatedCompletes!.push(v.completeFlow);
            console.log(`[Elevator] Elevated partial "${original[i].name}" → complete (later window shows outcome)`);
          } else {
            survivingPartials!.push(original[i]);
            if (v) console.log(`[Elevator] Kept "${original[i].name}" as partial: ${v.reason}`);
          }
        }
        if (elevatedCompletes!.length > 0) {
          analysis.complete_flows = [...(analysis.complete_flows ?? []), ...elevatedCompletes!];
        }
        analysis.partial_flows = survivingPartials;
      }

      // 4. Autonomous gap-closure pass on existing partial flows. This runs
      //    BEFORE the matcher so that partials promoted to complete this run
      //    can participate in matching as existing completes.
      const gapStats = await this.runGapClosure(descriptions, settings.detectionModel);
      if (gapStats.promoted > 0 || gapStats.updated > 0) {
        console.log(`[GapCloser] Autonomously promoted ${gapStats.promoted} partial(s), updated ${gapStats.updated} partial(s) with new answers`);
      }

      // 5. Evaluator pass — decide per newly-detected complete flow whether to
      //    save as new or merge into an existing flow. Also collapse any
      //    within-run duplicates. The evaluator has its own failure-isolation
      //    fallback (returns "all new" on error).
      const { complete: existingCompleteFlows } = await this.store.getAllFlows();
      const newlyDetected: NewlyDetectedFlow[] = (analysis.complete_flows ?? []).map((f) => ({
        name: f.name,
        trigger: f.trigger,
        apps: f.apps,
        stepsSummary: summarizeStepsForEvaluator(f.steps),
      }));
      const decisions = await this.evaluator.evaluate(
        newlyDetected,
        existingCompleteFlows,
        settings.detectionModel
      );
      logEvaluatorSummary(decisions);

      // 6. Save results (flows + knowledge), filtering source_windows to only real citations
      const validWindowStarts = new Set(descriptions.map((d) => d.frontmatter.windowStart));
      const result = await this.saveResults(
        analysis,
        validWindowStarts,
        decisions,
        existingCompleteFlows,
        settings.detectionModel
      );
      result.updatedComplete += gapStats.promoted;

      // 7. Mark descriptions as analyzed
      await this.descriptionStore.markAnalyzed(descriptions.map((d) => d.filePath));

      // 8. Link contributing descriptions so they survive age-based cleanup
      const cited = new Set<string>();
      for (const f of analysis.complete_flows ?? []) (f.source_windows ?? []).forEach((w) => cited.add(w));
      for (const f of analysis.partial_flows ?? []) (f.source_windows ?? []).forEach((w) => cited.add(w));
      for (const k of analysis.knowledge ?? []) (k.source_windows ?? []).forEach((w) => cited.add(w));
      const realCitations = Array.from(cited).filter((w) => validWindowStarts.has(w));
      if (realCitations.length > 0) {
        const linked = await this.descriptionStore.markLinked(realCitations);
        console.log(`[Detection] Linked ${linked} descriptions to detected flows/knowledge`);
      }

      return result;
    } finally {
      this.running = false;
    }
  }

  /**
   * Autonomous gap-closure across runs. For every on-disk partial flow with
   * open gap questions, ask the GapCloser whether the current run's new
   * observation narratives provide evidence that answers any gap. If all
   * gaps close, promote the partial to complete. If some close, update the
   * partial with the autonomous answers and the remaining questions.
   *
   * Returns counts of promoted and updated partials.
   */
  private async runGapClosure(
    descriptions: DescriptionDocument[],
    model: string
  ): Promise<{ promoted: number; updated: number }> {
    const { partial } = await this.store.getAllFlows();
    let promoted = 0;
    let updated = 0;

    for (const p of partial) {
      const originalQuestions = extractQuestions(p.body);
      if (originalQuestions.length === 0) continue;

      const result = await this.gapCloser.closeGaps(p, descriptions, model);
      if (result.answered.length === 0) continue;

      const newBody = insertAnswersAndRewriteQuestions(
        p.body,
        originalQuestions,
        result.answered,
        result.unanswered
      );

      if (result.unanswered.length === 0) {
        // All gaps closed — synthesize a clean complete body and promote.
        let completeBody: string;
        try {
          completeBody = await this.gapCloser.synthesizeCompleteBody(newBody, model);
        } catch (err) {
          // Synthesis failure: keep the partial updated with its inline answers
          // rather than losing the autonomous work. Skip promotion.
          console.warn(`[GapCloser] Synthesis failed for "${p.frontmatter.name}" — leaving as updated partial:`, err);
          const updatedFrontmatter: FlowFrontmatter = {
            ...p.frontmatter,
            gaps: 0,
            last_seen: new Date().toISOString(),
          };
          await this.store.updateFlow(p.filePath, updatedFrontmatter, newBody);
          updated++;
          continue;
        }

        // Re-classify the newly-promoted flow: it's no longer structurally
        // partial, so WorthJudge will evaluate it like any complete flow.
        const verdict = await this.worthJudge.classify(
          {
            type: "complete-flow",
            name: p.frontmatter.name,
            trigger: p.frontmatter.trigger ?? "",
            steps: completeBody,
            apps: p.frontmatter.apps,
            occurrences: p.frontmatter.occurrences,
            avgDurationMinutes: p.frontmatter.avg_duration,
          },
          model
        );

        const completeFrontmatter: FlowFrontmatter = {
          ...p.frontmatter,
          type: "complete-flow",
          confidence: "medium",
          last_seen: new Date().toISOString(),
          worth: verdict.worth === "noise" ? "repeatable-uncertain" : verdict.worth,
          worth_reason:
            verdict.worth === "noise"
              ? "Auto-promoted from partial; judge returned noise but promotion already done so tier coerced to repeatable-uncertain."
              : verdict.worth_reason,
          time_saved_estimate_minutes: verdict.time_saved_estimate_minutes,
        };
        // `gaps` is no longer meaningful on a complete flow — drop it.
        delete (completeFrontmatter as unknown as Record<string, unknown>).gaps;

        await this.store.promotePartialToComplete(p.filePath, completeFrontmatter, completeBody);
        promoted++;
        console.log(`[GapCloser] Promoted "${p.frontmatter.name}" to complete — ${result.answered.length} gap(s) closed autonomously`);
      } else {
        // Some gaps remain — rewrite the partial in place with the answered
        // gaps preserved and the surviving questions renumbered.
        const updatedFrontmatter: FlowFrontmatter = {
          ...p.frontmatter,
          gaps: result.unanswered.length,
          last_seen: new Date().toISOString(),
        };
        await this.store.updateFlow(p.filePath, updatedFrontmatter, newBody);
        updated++;
        console.log(`[GapCloser] Closed ${result.answered.length} of ${originalQuestions.length} gap(s) on "${p.frontmatter.name}"; ${result.unanswered.length} still open`);
      }
    }

    return { promoted, updated };
  }

  /**
   * Build interleaved parts, one chunk per description window:
   *   [ narrative header+body, then base64 of each key screenshot with its timestamp ]
   */
  private async buildWindowParts(
    descriptions: DescriptionDocument[]
  ): Promise<{
    header: string;
    body: string;
    keyScreenshots: { ts: string; base64: string }[];
  }[]> {
    const result: {
      header: string;
      body: string;
      keyScreenshots: { ts: string; base64: string }[];
    }[] = [];

    for (const d of descriptions) {
      const header = `## Window ${d.frontmatter.windowStart} → ${d.frontmatter.windowEnd}`;
      const keyPaths = await this.descriptionStore.getKeyScreenshotPaths(d.filePath);
      const keyScreenshots: { ts: string; base64: string }[] = [];
      for (const p of keyPaths) {
        try {
          const buf = await fsp.readFile(p);
          const ms = parseInt(path.basename(p).replace(".jpg", ""), 10);
          const ts = isNaN(ms) ? path.basename(p) : new Date(ms).toISOString();
          keyScreenshots.push({ ts, base64: buf.toString("base64") });
        } catch { /* skip unreadable */ }
      }
      result.push({ header, body: d.body, keyScreenshots });
    }
    return result;
  }

  private async analyzeWithGemini(
    model: string,
    windows: {
      header: string;
      body: string;
      keyScreenshots: { ts: string; base64: string }[];
    }[],
    thinking: boolean
  ): Promise<GeminiAnalysis> {
    const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [
      { text: DETECTION_PROMPT },
      { text: `\n\n## Activity Narratives\n\n` },
    ];

    for (const w of windows) {
      parts.push({ text: `\n\n${w.header}\n\n${w.body}\n` });
      if (w.keyScreenshots.length > 0) {
        parts.push({ text: `\n### Key visual frames for this window\n` });
        for (const ks of w.keyScreenshots) {
          parts.push({ text: `\n**${ks.ts}**\n` });
          parts.push({ inlineData: { mimeType: "image/jpeg", data: ks.base64 } });
        }
      }
    }

    const totalText = windows.reduce((s, w) => s + w.body.length + w.header.length, 0);
    const totalImages = windows.reduce((s, w) => s + w.keyScreenshots.length, 0);
    console.log(`[Detection] Sending ${totalText} chars + ${totalImages} key frames to ${model}${thinking ? " (thinking)" : ""}`);

    const apiCall = this.genai.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config: {
        responseMimeType: "application/json",
        ...(thinking ? { thinkingConfig: { thinkingBudget: 8192 } } : {}),
      },
    });

    const response = await Promise.race([
      apiCall,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Gemini detection timed out after 120s`)),
          120_000
        )
      ),
    ]);
    console.log(`[Detection] Gemini response received`);

    let text = response.text ?? "";
    text = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    text = text.replace(/[\x00-\x1f\x7f]/g, (ch) =>
      ch === "\n" || ch === "\r" || ch === "\t" ? ch : ""
    );
    return JSON.parse(text) as GeminiAnalysis;
  }

  private async saveResults(
    analysis: GeminiAnalysis,
    validWindowStarts: Set<string>,
    decisions: EvaluatorResult,
    existingCompleteFlows: FlowDocument[],
    detectionModel: string
  ): Promise<DetectionResult> {
    const filterCitations = (ws?: string[]): string[] =>
      (ws ?? []).filter((w) => validWindowStarts.has(w));

    const result: DetectionResult = {
      newComplete: 0,
      updatedComplete: 0,
      newPartial: 0,
      newKnowledge: 0,
      filesWritten: [],
    };

    const now = new Date().toISOString();
    const completeFlows = analysis.complete_flows ?? [];
    const existingById = new Map(existingCompleteFlows.map((f) => [f.frontmatter.id, f]));

    // Resolve within-run duplicates — collapse B into A, carrying source_windows
    // and apps forward so the survivor keeps all the evidence.
    const survivorOf = resolveWithinRunDupes(completeFlows.length, decisions.withinRunDupes);
    const carried: { sourceWindows: Set<string>; apps: Set<string> }[] =
      completeFlows.map(() => ({ sourceWindows: new Set(), apps: new Set() }));
    for (let i = 0; i < completeFlows.length; i++) {
      const survivor = survivorOf[i];
      if (survivor === i) continue;
      // i was collapsed into survivor — push i's evidence onto survivor's carry set
      for (const w of filterCitations(completeFlows[i].source_windows)) carried[survivor].sourceWindows.add(w);
      for (const a of completeFlows[i].apps ?? []) carried[survivor].apps.add(a);
    }

    // Build quick lookup from index → decision (for survivors).
    const decisionByIndex = new Map(decisions.complete.map((d) => [d.index, d]));

    for (let i = 0; i < completeFlows.length; i++) {
      if (survivorOf[i] !== i) continue; // collapsed dupes are not saved separately
      const flow = completeFlows[i];
      const decision = decisionByIndex.get(i);

      // Union cited source_windows with any carried from collapsed within-run dupes.
      const mergedWindows = Array.from(
        new Set([...filterCitations(flow.source_windows), ...carried[i].sourceWindows])
      );
      const mergedApps = Array.from(new Set([...(flow.apps ?? []), ...carried[i].apps]));

      if (decision?.kind === "merge" && decision.matchedFlowId) {
        const target = existingById.get(decision.matchedFlowId);
        if (target) {
          const postMergeOccurrences = (target.frontmatter.occurrences ?? 1) + 1;
          const verdict = await this.worthJudge.classify(
            {
              type: "complete-flow",
              name: flow.name,
              trigger: flow.trigger,
              steps: flow.steps,
              apps: mergedApps,
              occurrences: postMergeOccurrences,
              avgDurationMinutes: flow.avg_duration_minutes,
              decisionLogic: flow.decision_logic,
              toolsAndData: flow.tools_and_data,
              automationClassification: flow.automation_classification,
              variations: flow.variations,
            },
            detectionModel
          );
          if (verdict.worth === "noise") {
            console.log(`[WorthJudge] Dropped merge into "${target.frontmatter.name}" — classified as noise: ${verdict.worth_reason}`);
            continue;
          }
          // Reconcile the existing stored body with the new observation so
          // merges don't leave the body stale. The refiner is lossless on
          // failure (returns the existing body unchanged).
          const refinedBody = await this.bodyRefiner.refine(
            target.body,
            {
              name: flow.name,
              trigger: flow.trigger,
              steps: flow.steps,
              decision_logic: flow.decision_logic,
              tools_and_data: flow.tools_and_data,
              automation_classification: flow.automation_classification,
              variations: flow.variations,
            },
            detectionModel
          );
          // Re-extract parameters only when the body actually changed —
          // parameters depend on the body text, so a same-body merge would
          // produce the same list.
          let mergedParameters: FlowFrontmatter["parameters"] | undefined;
          if (refinedBody !== target.body) {
            const fresh = await this.paramExtractor.extract(flow.name, refinedBody, detectionModel);
            mergedParameters = mergeParameterLists(target.frontmatter.parameters, fresh);
          }
          await this.store.mergeFlow(target.filePath, {
            newSourceWindows: mergedWindows,
            newApps: mergedApps,
            now,
            worth: verdict.worth,
            worth_reason: verdict.worth_reason,
            time_saved_estimate_minutes: verdict.time_saved_estimate_minutes,
            newBody: refinedBody === target.body ? undefined : refinedBody,
            parameters: mergedParameters,
          });
          result.updatedComplete++;
          result.filesWritten.push(target.filePath);
          const bodyNote = refinedBody === target.body ? "body unchanged" : "body refined";
          const paramsNote = mergedParameters ? `, parameters=${mergedParameters.length}` : "";
          console.log(`[Detection] Merged "${flow.name}" into existing "${target.frontmatter.name}" (${decision.reason}); worth=${verdict.worth}; ${bodyNote}${paramsNote}`);
          continue;
        }
        // Fallthrough: matchedFlowId didn't resolve — save as new (defensive; evaluator should have filtered this).
        console.warn(`[Detection] Evaluator returned merge with unresolved id ${decision.matchedFlowId}; saving as new`);
      }

      // Fresh flow — classify before saving so we can drop noise.
      const verdict = await this.worthJudge.classify(
        {
          type: "complete-flow",
          name: flow.name,
          trigger: flow.trigger,
          steps: flow.steps,
          apps: mergedApps,
          occurrences: 1,
          avgDurationMinutes: flow.avg_duration_minutes,
          decisionLogic: flow.decision_logic,
          toolsAndData: flow.tools_and_data,
          automationClassification: flow.automation_classification,
          variations: flow.variations,
        },
        detectionModel
      );
      if (verdict.worth === "noise") {
        console.log(`[WorthJudge] Dropped new complete flow "${flow.name}" — classified as noise: ${verdict.worth_reason}`);
        continue;
      }

      const body = `# ${flow.name}

## Trigger
${flow.trigger}

## Steps
${flow.steps}

## Decision Logic
${flow.decision_logic}

## Tools & Data Sources
${flow.tools_and_data}

## Automation Classification
${flow.automation_classification}

## Variations Observed
${flow.variations}`;

      const params = await this.paramExtractor.extract(flow.name, body, detectionModel);

      const frontmatter: FlowFrontmatter = {
        type: "complete-flow",
        id: `flow-${uuid()}`,
        name: flow.name,
        detected: now,
        last_seen: now,
        occurrences: 1,
        confidence: flow.confidence as "high" | "medium",
        avg_duration: flow.avg_duration_minutes,
        trigger: flow.trigger,
        apps: mergedApps,
        source_windows: mergedWindows,
        worth: verdict.worth,
        worth_reason: verdict.worth_reason,
        time_saved_estimate_minutes: verdict.time_saved_estimate_minutes,
        ...(params.length > 0 ? { parameters: params } : {}),
      };

      const filePath = await this.store.saveFlow("complete", frontmatter, body);
      result.newComplete++;
      result.filesWritten.push(filePath);
      console.log(`[Detection] Saved new complete flow "${flow.name}"; worth=${verdict.worth}, est. ${verdict.time_saved_estimate_minutes} min saved, parameters=${params.length}`);
    }

    for (const flow of analysis.partial_flows ?? []) {
      const gapCount = (flow.observed_steps.match(/\[GAP\]/g) ?? []).length;
      const verdict = await this.worthJudge.classify(
        {
          type: "partial-flow",
          name: flow.name,
          trigger: "", // partials may not have a crisp trigger yet
          steps: flow.observed_steps,
          apps: flow.apps,
          occurrences: 1,
          gaps: gapCount,
        },
        detectionModel
      );
      // A partial could hypothetically come back as noise if it has no gaps AND
      // the judge considers it non-repeatable. Drop it rather than polluting
      // the partial-flow folder.
      if (verdict.worth === "noise") {
        console.log(`[WorthJudge] Dropped new partial flow "${flow.name}" — classified as noise: ${verdict.worth_reason}`);
        continue;
      }

      const frontmatter: FlowFrontmatter = {
        type: "partial-flow",
        id: `flow-${uuid()}`,
        name: flow.name,
        detected: now,
        last_seen: now,
        occurrences: 1,
        confidence: flow.confidence as "low" | "medium",
        gaps: gapCount,
        apps: flow.apps,
        source_windows: filterCitations(flow.source_windows),
        worth: verdict.worth,
        worth_reason: verdict.worth_reason,
        time_saved_estimate_minutes: verdict.time_saved_estimate_minutes,
      };

      const body = `# ${flow.name} (Partial)

## Observed Steps
${flow.observed_steps}

## Questions to Complete This Flow
${flow.questions.map((q, i) => `- Q${i + 1}: ${q}`).join("\n")}

## What I Think Is Happening
${flow.best_guess}`;

      const filePath = await this.store.saveFlow("partial", frontmatter, body);
      result.newPartial++;
      result.filesWritten.push(filePath);
    }

    for (const k of analysis.knowledge ?? []) {
      const frontmatter: KnowledgeFrontmatter = {
        type: "knowledge",
        id: `knowledge-${uuid()}`,
        detected: now,
        category: k.category as KnowledgeFrontmatter["category"],
        apps: k.apps,
      };

      const body = `# ${k.title}

## Observation
${k.observation}

## Potential Significance
${k.significance}

## Related Flows
${k.related_flows.map((r) => `- ${r}`).join("\n") || "- None yet"}`;

      const filePath = await this.store.saveKnowledge(frontmatter, body);
      result.newKnowledge++;
      result.filesWritten.push(filePath);
    }

    const summary = `# FlowMind Run — ${now}
- Complete flows detected: ${result.newComplete} (new: ${result.newComplete}, updated: ${result.updatedComplete})
- Partial flows detected: ${result.newPartial}
- Knowledge fragments: ${result.newKnowledge}
- Files written: ${result.filesWritten.map((f) => `\n  - ${f}`).join("")}`;

    await this.store.saveSummary(summary);

    return result;
  }
}

/**
 * Union-find over within-run duplicate pairs. Returns an array where result[i]
 * is the index of the surviving flow that index i should collapse into.
 * Survivors have result[i] === i.
 *
 * The survivor for any connected component is always the minimum index, so the
 * first-occurring flow in that run is the one kept.
 */
function resolveWithinRunDupes(
  count: number,
  pairs: { indexA: number; indexB: number }[]
): number[] {
  const parent = Array.from({ length: count }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    // Point the larger-rooted component at the smaller index — this keeps the
    // earliest-index flow as the canonical survivor for its component.
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };
  for (const { indexA, indexB } of pairs) {
    if (indexA < 0 || indexA >= count || indexB < 0 || indexB >= count) continue;
    union(indexA, indexB);
  }
  return Array.from({ length: count }, (_, i) => find(i));
}

/** Short, uniform log summary of what the evaluator decided. */
function logEvaluatorSummary(decisions: EvaluatorResult): void {
  const merges = decisions.complete.filter((d) => d.kind === "merge").length;
  const news = decisions.complete.length - merges;
  const dupes = decisions.withinRunDupes.length;
  console.log(`[Evaluator] ${decisions.complete.length} complete flows evaluated: ${news} new, ${merges} merge, ${dupes} within-run dupes`);
  for (const d of decisions.complete) {
    if (d.kind === "merge") {
      console.log(`[Evaluator]   merge #${d.index} → ${d.matchedFlowId} — ${d.reason}`);
    }
  }
  for (const d of decisions.withinRunDupes) {
    console.log(`[Evaluator]   within-run dupe #${d.indexA} & #${d.indexB} — ${d.reason}`);
  }
}

/**
 * Merge a freshly-extracted parameter list with the existing one from disk.
 * Key on `name`. For matching parameters, union observed_values (de-duped,
 * capped at 8) and prefer the existing `kind` / `fixed_value` / `rule` if the
 * user has already classified them — don't clobber user classification on
 * every merge.
 */
function mergeParameterLists(
  existing: import("../types").FlowParameter[] | undefined,
  fresh: import("../types").FlowParameter[]
): import("../types").FlowParameter[] {
  const byName = new Map<string, import("../types").FlowParameter>();
  for (const p of existing ?? []) byName.set(p.name, p);
  for (const p of fresh) {
    const prior = byName.get(p.name);
    if (!prior) {
      byName.set(p.name, p);
      continue;
    }
    const mergedValues = Array.from(
      new Set([...(prior.observed_values ?? []), ...(p.observed_values ?? [])])
    ).slice(0, 8);
    byName.set(p.name, {
      // Keep the most-specific description (prefer fresh if non-empty, else prior)
      name: prior.name,
      description: p.description || prior.description,
      // Prefer the classified `kind` (user wouldn't want it reset to null).
      kind: prior.kind ?? p.kind,
      observed_values: mergedValues.length > 0 ? mergedValues : undefined,
      fixed_value: prior.fixed_value,
      rule: prior.rule,
    });
  }
  return Array.from(byName.values());
}

/** Compact the model's `steps` markdown into a short line for the evaluator prompt. */
function summarizeStepsForEvaluator(steps: string): string {
  const compact = (steps ?? "").replace(/\s+/g, " ").trim();
  return compact.length > 400 ? compact.slice(0, 400) + "…" : compact;
}

interface GeminiAnalysis {
  complete_flows?: {
    name: string;
    confidence: string;
    avg_duration_minutes: number;
    trigger: string;
    apps: string[];
    steps: string;
    decision_logic: string;
    tools_and_data: string;
    automation_classification: string;
    variations: string;
    source_windows?: string[];
  }[];
  partial_flows?: {
    name: string;
    confidence: string;
    apps: string[];
    observed_steps: string;
    questions: string[];
    best_guess: string;
    source_windows?: string[];
  }[];
  knowledge?: {
    title: string;
    category: string;
    apps: string[];
    observation: string;
    significance: string;
    related_flows: string[];
    source_windows?: string[];
  }[];
}
