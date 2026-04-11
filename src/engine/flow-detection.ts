import { GoogleGenAI } from "@google/genai";
import { v4 as uuid } from "uuid";
import fsp from "node:fs/promises";
import path from "node:path";
import { FlowStore } from "./flow-store";
import { DescriptionStore, type DescriptionDocument } from "./description-store";
import { loadConfig } from "../config";
import { getEffectiveSettings } from "../ai/mode-presets";
import type {
  DetectionResult,
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
  private running = false;

  constructor(store: FlowStore, descriptionStore: DescriptionStore) {
    this.store = store;
    this.descriptionStore = descriptionStore;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    this.genai = new GoogleGenAI({ apiKey });
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

      // 4. Save results (flows + knowledge), filtering source_windows to only real citations
      const validWindowStarts = new Set(descriptions.map((d) => d.frontmatter.windowStart));
      const result = await this.saveResults(analysis, validWindowStarts);

      // 5. Mark descriptions as analyzed
      await this.descriptionStore.markAnalyzed(descriptions.map((d) => d.filePath));

      // 6. Link contributing descriptions so they survive age-based cleanup
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
    validWindowStarts: Set<string>
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

    for (const flow of analysis.complete_flows ?? []) {
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
        apps: flow.apps,
        source_windows: filterCitations(flow.source_windows),
      };

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

      const filePath = await this.store.saveFlow("complete", frontmatter, body);
      result.newComplete++;
      result.filesWritten.push(filePath);
    }

    for (const flow of analysis.partial_flows ?? []) {
      const frontmatter: FlowFrontmatter = {
        type: "partial-flow",
        id: `flow-${uuid()}`,
        name: flow.name,
        detected: now,
        last_seen: now,
        occurrences: 1,
        confidence: flow.confidence as "low" | "medium",
        gaps: (flow.observed_steps.match(/\[GAP\]/g) ?? []).length,
        apps: flow.apps,
        source_windows: filterCitations(flow.source_windows),
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
