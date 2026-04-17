import { GoogleGenAI } from "@google/genai";
import type { EvaluatorResult, FlowDocument } from "../types";

/**
 * Input to the evaluator: the freshly detected complete flows from phase 2.
 * Only the fields the matcher needs — we don't feed it the full step markdown,
 * to keep the prompt compact.
 */
export interface NewlyDetectedFlow {
  name: string;
  trigger: string;
  apps: string[];
  /** Short summary of the steps — first ~400 chars of the model's `steps` field is enough for matching. */
  stepsSummary: string;
}

const EVALUATOR_PROMPT = `You are FlowMind's evaluator. You compare newly-detected workflow flows against flows already on record, and decide whether each new flow is the same workflow as an existing one or is genuinely new.

Two flows are the SAME workflow when they:
- accomplish the same user goal (e.g. "save an article to a topic folder"),
- use overlapping apps and a similar sequence of actions,
- would be described by the user as "the same thing I do regularly".

Two flows are DIFFERENT when:
- the goal differs (e.g. "bookmark" vs "save as PDF"),
- the apps are different ecosystems,
- the steps are structurally different even when some actions overlap.

Small variations in content (different article, different folder name, different search query) do NOT make flows different — those are parameters of the same workflow.

Also flag any two NEWLY-DETECTED flows that describe the same activity emitted twice in the same run (e.g. phase 2 split a single workflow across two outputs). Use the \`within_run_dupes\` array for those.

Respond with ONLY valid JSON in this exact shape:
{
  "complete": [
    {
      "index": 0,
      "kind": "new" | "merge",
      "matchedFlowId": "<existing-flow-id when kind is merge; omit otherwise>",
      "reason": "One short sentence explaining the decision."
    }
  ],
  "within_run_dupes": [
    {
      "indexA": 0,
      "indexB": 2,
      "reason": "Short reason."
    }
  ]
}

Rules:
- Provide exactly one entry per newly-detected flow, in order.
- Use "merge" only when you have strong evidence the flows are the same workflow. When in doubt, return "new".
- \`matchedFlowId\` MUST be copied character-for-character from an existing flow's "id" field listed below. Never invent an id.
- If there are no existing flows, every decision must be "new".
- If there are no within-run duplicates, return an empty array for \`within_run_dupes\`.`;

export class FlowEvaluator {
  private genai: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    this.genai = new GoogleGenAI({ apiKey });
  }

  /**
   * Decide, for each newly-detected complete flow, whether to save it as a new
   * file or merge it into an existing flow. Also flag within-run duplicates.
   *
   * Safe fallback: if the Gemini call throws or returns malformed JSON, every
   * decision is "new" (today's behaviour) and `withinRunDupes` is empty. The
   * detection pipeline never breaks because of evaluator issues.
   */
  async evaluate(
    newlyDetected: NewlyDetectedFlow[],
    existingComplete: FlowDocument[],
    model: string
  ): Promise<EvaluatorResult> {
    if (newlyDetected.length === 0) {
      return { complete: [], withinRunDupes: [] };
    }

    // Pre-filter: only existing flows that share at least one app with any
    // newly-detected flow are candidates. Keeps the prompt bounded as the
    // library grows.
    const newApps = new Set<string>();
    for (const f of newlyDetected) for (const a of f.apps) newApps.add(a.toLowerCase());
    const candidates = existingComplete.filter((doc) =>
      (doc.frontmatter.apps ?? []).some((a) => newApps.has(a.toLowerCase()))
    );

    // With no overlapping-app candidates, the answer is "all new" — skip the
    // API call entirely.
    if (candidates.length === 0) {
      return {
        complete: newlyDetected.map((_, index) => ({
          index,
          kind: "new" as const,
          reason: "No existing flows share apps with this one.",
        })),
        withinRunDupes: [],
      };
    }

    try {
      return await this.callGemini(newlyDetected, candidates, model);
    } catch (err) {
      console.warn(`[Evaluator] Call failed, falling back to 'all new':`, err);
      return {
        complete: newlyDetected.map((_, index) => ({
          index,
          kind: "new" as const,
          reason: "Evaluator call failed — defaulting to new.",
        })),
        withinRunDupes: [],
      };
    }
  }

  private async callGemini(
    newlyDetected: NewlyDetectedFlow[],
    candidates: FlowDocument[],
    model: string
  ): Promise<EvaluatorResult> {
    const existingSection = candidates
      .map((doc) => {
        const fm = doc.frontmatter;
        const trigger = fm.trigger ? ` (trigger: ${fm.trigger})` : "";
        return `- id: ${fm.id}\n  name: ${fm.name}\n  apps: [${fm.apps.join(", ")}]${trigger}\n  steps_summary: ${summarizeBody(doc.body)}`;
      })
      .join("\n");

    const newSection = newlyDetected
      .map(
        (f, i) =>
          `- index: ${i}\n  name: ${f.name}\n  apps: [${f.apps.join(", ")}]\n  trigger: ${f.trigger}\n  steps_summary: ${f.stepsSummary}`
      )
      .join("\n");

    const prompt = `${EVALUATOR_PROMPT}\n\n## Existing flows on record\n\n${existingSection}\n\n## Newly-detected flows (this run)\n\n${newSection}`;

    console.log(
      `[Evaluator] Comparing ${newlyDetected.length} new vs ${candidates.length} existing (app-filtered) using ${model}`
    );

    const apiCall = this.genai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json" },
    });

    const response = await Promise.race([
      apiCall,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Evaluator timed out after 60s")), 60_000)
      ),
    ]);

    let text = (response.text ?? "").trim();
    text = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    text = text.replace(/[\x00-\x1f\x7f]/g, (ch) =>
      ch === "\n" || ch === "\r" || ch === "\t" ? ch : ""
    );

    const parsed = JSON.parse(text) as {
      complete?: {
        index: number;
        kind: string;
        matchedFlowId?: string;
        reason?: string;
      }[];
      within_run_dupes?: { indexA: number; indexB: number; reason?: string }[];
    };

    // Validate and normalize the model's output — drop any entries pointing at
    // non-existent existing flows, and backfill missing decisions with "new".
    const existingIds = new Set(candidates.map((c) => c.frontmatter.id));
    const byIndex = new Map<number, EvaluatorResult["complete"][number]>();
    for (const d of parsed.complete ?? []) {
      if (typeof d.index !== "number" || d.index < 0 || d.index >= newlyDetected.length) continue;
      if (d.kind === "merge" && (!d.matchedFlowId || !existingIds.has(d.matchedFlowId))) {
        byIndex.set(d.index, {
          index: d.index,
          kind: "new",
          reason: "Model returned merge with unknown matchedFlowId; defaulting to new.",
        });
        continue;
      }
      byIndex.set(d.index, {
        index: d.index,
        kind: d.kind === "merge" ? "merge" : "new",
        matchedFlowId: d.kind === "merge" ? d.matchedFlowId : undefined,
        reason: (d.reason ?? "").trim() || "No reason given.",
      });
    }
    const complete: EvaluatorResult["complete"] = newlyDetected.map((_, i) =>
      byIndex.get(i) ?? {
        index: i,
        kind: "new",
        reason: "Model omitted a decision; defaulting to new.",
      }
    );

    const withinRunDupes = (parsed.within_run_dupes ?? [])
      .filter(
        (d) =>
          typeof d.indexA === "number" &&
          typeof d.indexB === "number" &&
          d.indexA !== d.indexB &&
          d.indexA >= 0 &&
          d.indexA < newlyDetected.length &&
          d.indexB >= 0 &&
          d.indexB < newlyDetected.length
      )
      .map((d) => ({
        indexA: d.indexA,
        indexB: d.indexB,
        reason: (d.reason ?? "").trim() || "No reason given.",
      }));

    return { complete, withinRunDupes };
  }
}

/**
 * Compress a flow body to a short line for the evaluator prompt. We strip the
 * headings and keep only the Steps section's first ~400 chars — enough signal
 * for the matcher without bloating the prompt.
 */
function summarizeBody(body: string): string {
  const stepsMatch = body.match(/## Steps\s*\n([\s\S]*?)(?:\n## |$)/);
  const steps = stepsMatch?.[1]?.trim() ?? body;
  const compact = steps.replace(/\s+/g, " ").trim();
  return compact.length > 400 ? compact.slice(0, 400) + "…" : compact;
}
