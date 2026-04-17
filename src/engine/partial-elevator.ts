import { GoogleGenAI } from "@google/genai";
import type { DescriptionDocument } from "./description-store";

/**
 * One partial flow output from phase 2, in the exact shape flow-detection.ts
 * already builds. Kept narrow so the elevator doesn't need the full
 * GeminiAnalysis type.
 */
export interface InRunPartialFlow {
  name: string;
  confidence: string;
  apps: string[];
  observed_steps: string;
  questions: string[];
  best_guess: string;
  source_windows?: string[];
}

/**
 * One complete flow output shape — the same fields flow-detection.ts
 * consumes, so the elevator's output slots directly into the existing
 * complete_flows list.
 */
export interface InRunCompleteFlow {
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
}

/**
 * Verdict per partial examined:
 *   - { elevate: true, completeFlow } — the partial should be replaced by
 *     this complete flow in the run output. The partial is dropped.
 *   - { elevate: false } — the partial stays as partial.
 */
export type ElevatorVerdict =
  | { partialIndex: number; elevate: true; completeFlow: InRunCompleteFlow }
  | { partialIndex: number; elevate: false; reason: string };

const ELEVATOR_PROMPT = `You are FlowMind's partial-flow elevator. You receive a partial flow that phase 2 emitted — a workflow shape with unanswered gap questions — and all the narrative windows from the same capture. Your job: decide whether later windows in the capture actually show the user reaching a concrete outcome for this flow.

If they DO, the flow was never partial; phase 2 cut it too early. Emit a COMPLETE flow that covers the whole story (the search/retry/etc. portion in the partial PLUS the outcome in the later windows). Include the full set of source_windows that contributed — partial's + the later ones that show the outcome.

If they do NOT (no later outcome for this flow's goal), leave the partial as-is.

Be strict:
- "Outcome reached" means a concrete observable result: a file saved, a message sent, a form submitted, a calendar event created, an item added to a list, etc. Scrolling and reading do NOT count.
- The outcome must match the SAME subject/goal as the partial. If the partial is about researching Gemini and a later window shows a file saved for Claude, that's NOT the same flow.
- If you're unsure, return elevate=false — don't fabricate an outcome.

Respond with ONLY valid JSON in this exact shape:

{
  "elevate": true,
  "complete": {
    "name": "...",
    "confidence": "high" | "medium",
    "avg_duration_minutes": number,
    "trigger": "what starts this flow",
    "apps": ["app1", "app2"],
    "steps": "Full markdown steps section (including the retry/search variation if present)",
    "decision_logic": "Markdown decision logic",
    "tools_and_data": "Markdown tools & data sources",
    "automation_classification": "Markdown classification",
    "variations": "Markdown variations — include the iterative-search pattern if the user retried searches",
    "source_windows": ["<windowStart ISO>", "..."]
  }
}

or

{
  "elevate": false,
  "reason": "One short sentence on why no later window shows a concrete outcome for this flow."
}`;

export class PartialElevator {
  private genai: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    this.genai = new GoogleGenAI({ apiKey });
  }

  /**
   * Examine each newly-emitted partial against the full set of window
   * narratives for this run. Returns one verdict per partial in input order.
   *
   * Safe fallback: on any Gemini failure, returns elevate=false for every
   * partial. The detection pipeline cannot regress because of elevator
   * issues — partials that the elevator fails on simply remain partial.
   */
  async elevateAll(
    partials: InRunPartialFlow[],
    descriptions: DescriptionDocument[],
    model: string
  ): Promise<ElevatorVerdict[]> {
    if (partials.length === 0) return [];
    // Serial, not parallel — cheap enough for typical N (usually 1-3 partials
    // per run) and easier to reason about failure isolation.
    const verdicts: ElevatorVerdict[] = [];
    for (let i = 0; i < partials.length; i++) {
      try {
        verdicts.push(await this.elevateOne(i, partials[i], descriptions, model));
      } catch (err) {
        console.warn(`[Elevator] Partial "${partials[i].name}" kept as partial (call failed):`, err);
        verdicts.push({
          partialIndex: i,
          elevate: false,
          reason: "Elevator call failed — partial kept as-is.",
        });
      }
    }
    return verdicts;
  }

  private async elevateOne(
    partialIndex: number,
    partial: InRunPartialFlow,
    descriptions: DescriptionDocument[],
    model: string
  ): Promise<ElevatorVerdict> {
    const narrativesSection = descriptions
      .map((d) => `### windowStart: ${d.frontmatter.windowStart}\n${d.body}`)
      .join("\n\n---\n\n");

    const partialSection = [
      `### Partial flow emitted by phase 2`,
      `name: ${partial.name}`,
      `apps: [${partial.apps.join(", ")}]`,
      `observed_steps:\n${partial.observed_steps}`,
      `questions:\n${partial.questions.map((q, i) => `  Q${i + 1}: ${q}`).join("\n")}`,
      `best_guess: ${partial.best_guess}`,
    ].join("\n");

    const prompt = `${ELEVATOR_PROMPT}\n\n## Capture narratives (all windows)\n\n${narrativesSection}\n\n${partialSection}`;

    const apiCall = this.genai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json" },
    });

    const response = await Promise.race([
      apiCall,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Elevator timed out after 60s")), 60_000)
      ),
    ]);

    let text = (response.text ?? "").trim();
    text = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    text = text.replace(/[\x00-\x1f\x7f]/g, (ch) =>
      ch === "\n" || ch === "\r" || ch === "\t" ? ch : ""
    );

    const parsed = JSON.parse(text) as {
      elevate?: boolean;
      complete?: Partial<InRunCompleteFlow>;
      reason?: string;
    };

    if (parsed.elevate === true && parsed.complete) {
      const c = parsed.complete;
      // Guard against the model omitting required fields — fall back to
      // elevate=false rather than emitting a malformed complete flow.
      if (!c.name || !c.steps || !c.trigger || !c.apps) {
        return {
          partialIndex,
          elevate: false,
          reason: "Elevator returned malformed complete flow; partial kept as-is.",
        };
      }
      return {
        partialIndex,
        elevate: true,
        completeFlow: {
          name: c.name,
          confidence: c.confidence ?? "medium",
          avg_duration_minutes: typeof c.avg_duration_minutes === "number" ? c.avg_duration_minutes : 1,
          trigger: c.trigger,
          apps: c.apps,
          steps: c.steps,
          decision_logic: c.decision_logic ?? "",
          tools_and_data: c.tools_and_data ?? "",
          automation_classification: c.automation_classification ?? "",
          variations: c.variations ?? "",
          source_windows: c.source_windows ?? partial.source_windows ?? [],
        },
      };
    }

    return {
      partialIndex,
      elevate: false,
      reason: (parsed.reason ?? "").trim() || "No reason given.",
    };
  }
}
