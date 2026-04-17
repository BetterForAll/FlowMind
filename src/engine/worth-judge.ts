import { GoogleGenAI } from "@google/genai";
import type { FlowWorth } from "../types";

/**
 * A flow summary tailored for the worth classifier. Kept compact on purpose —
 * the judge shouldn't need full markdown to decide if an activity is a
 * meaningful workflow.
 */
export interface FlowForJudgment {
  type: "complete-flow" | "partial-flow";
  name: string;
  trigger: string;
  /** Raw steps markdown. Truncated by the judge if long. */
  steps: string;
  apps: string[];
  occurrences: number;
  /** Average duration in minutes, if phase 2 reported one. */
  avgDurationMinutes?: number;
  /** Number of interview gaps remaining, if this is a partial flow. */
  gaps?: number;
}

export interface WorthVerdict {
  worth: FlowWorth;
  worth_reason: string;
  time_saved_estimate_minutes: number;
}

const WORTH_PROMPT = `You are FlowMind's worth judge. You look at a detected workflow and decide whether it is meaningful enough to automate, or whether it is just noise that happens to look like a pattern.

Assign one of these tiers:

- "noise": NOT a repeatable workflow. Examples: user jumping between unrelated YouTube videos, scrolling news, opening and closing apps without producing a concrete outcome, idle browsing. These should not be saved as flows. A window of activity without a trigger-to-outcome shape is noise.
- "partial-with-gaps": a workflow shape is visible but some steps, decisions, or outcomes are unclear. The flow has unanswered gap questions that need clarification before it can be reliably reproduced or automated.
- "repeatable-uncertain": reproducible steps with a clear outcome, but the automation payoff is uncertain. Either the steps are simple enough to do manually, the trigger is not routine, or the user's intent is unclear. Might still be useful, but not a top automation candidate.
- "meaningful": a clear trigger, reproducible steps, a concrete outcome, and a plausible reason to believe this will recur. These are the prime automation candidates.

A flow IS meaningful when:
- it has a concrete trigger ("when the user wants to save an article for later")
- it has a concrete outcome ("a file named after the article is saved to a topic folder")
- steps follow a recognizable, reproducible sequence
- it is plausibly repeatable — something the user would do more than once

A flow IS NOT meaningful (noise) when:
- it is just browsing or jumping between apps with no outcome
- it is a one-off, situational activity unlikely to recur
- there is no identifiable goal beyond "the user was active on the computer"

Also provide:
- A one-sentence \`worth_reason\` explaining the tier.

Respond with ONLY valid JSON:
{
  "worth": "noise" | "partial-with-gaps" | "repeatable-uncertain" | "meaningful",
  "worth_reason": "One sentence."
}`;

export class WorthJudge {
  private genai: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    this.genai = new GoogleGenAI({ apiKey });
  }

  /**
   * Classify a flow's worth. On any failure (throw, timeout, malformed JSON)
   * returns a neutral "repeatable-uncertain" verdict — safe default that
   * neither drops the flow (as noise would) nor falsely elevates it.
   */
  async classify(flow: FlowForJudgment, model: string): Promise<WorthVerdict> {
    const timeSaved = estimateTimeSavedMinutes(flow.avgDurationMinutes, flow.occurrences);

    // Partial flows with open gaps are tier-locked to "partial-with-gaps" —
    // no point asking the judge, the tier is structural.
    if (flow.type === "partial-flow" && (flow.gaps ?? 0) > 0) {
      return {
        worth: "partial-with-gaps",
        worth_reason: `Partial flow has ${flow.gaps} unanswered gap${flow.gaps === 1 ? "" : "s"} — tier reflects structural status.`,
        time_saved_estimate_minutes: timeSaved,
      };
    }

    try {
      const verdict = await this.callGemini(flow, model);
      return { ...verdict, time_saved_estimate_minutes: timeSaved };
    } catch (err) {
      console.warn(`[WorthJudge] Classify failed for "${flow.name}" — defaulting to repeatable-uncertain:`, err);
      return {
        worth: "repeatable-uncertain",
        worth_reason: "Classifier call failed — defaulting to neutral tier.",
        time_saved_estimate_minutes: timeSaved,
      };
    }
  }

  private async callGemini(flow: FlowForJudgment, model: string): Promise<Omit<WorthVerdict, "time_saved_estimate_minutes">> {
    const compactSteps = flow.steps.replace(/\s+/g, " ").trim().slice(0, 1200);
    const duration = flow.avgDurationMinutes != null ? `${flow.avgDurationMinutes} min` : "unknown";

    const prompt = `${WORTH_PROMPT}

## Flow to evaluate

- name: ${flow.name}
- type: ${flow.type}
- trigger: ${flow.trigger || "(none given)"}
- apps: [${flow.apps.join(", ")}]
- occurrences observed: ${flow.occurrences}
- avg duration: ${duration}
- steps: ${compactSteps}
`;

    const apiCall = this.genai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json" },
    });

    const response = await Promise.race([
      apiCall,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("WorthJudge timed out after 45s")), 45_000)
      ),
    ]);

    let text = (response.text ?? "").trim();
    text = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    text = text.replace(/[\x00-\x1f\x7f]/g, (ch) =>
      ch === "\n" || ch === "\r" || ch === "\t" ? ch : ""
    );
    const parsed = JSON.parse(text) as { worth?: string; worth_reason?: string };

    const worth = coerceWorth(parsed.worth);
    const reason = (parsed.worth_reason ?? "").trim() || "No reason given by the model.";
    return { worth, worth_reason: reason };
  }
}

/**
 * Rough time-saved estimate. Deliberately simple — this is a relative ranking
 * signal, not a forecasting model.
 *
 *   per-occurrence savings = avg_duration - assumed automation runtime (≈1 min)
 *   expected future occurrences = max(observed, 3) - 1
 *     (max(..,3) reflects our belief that a detected-once flow will likely
 *      recur; -1 discounts the one we already observed.)
 *
 *   total = per-occurrence × expected-future, floored at 0.
 */
export function estimateTimeSavedMinutes(
  avgDurationMinutes: number | undefined,
  occurrences: number
): number {
  if (!avgDurationMinutes || avgDurationMinutes <= 0) return 0;
  const perOccurrence = Math.max(avgDurationMinutes - 1, 0);
  const expectedFuture = Math.max(Math.max(occurrences, 3) - 1, 0);
  return Math.round(perOccurrence * expectedFuture);
}

function coerceWorth(raw: string | undefined): FlowWorth {
  switch ((raw ?? "").toLowerCase().trim()) {
    case "noise":
      return "noise";
    case "partial-with-gaps":
    case "partial_with_gaps":
    case "partial":
      return "partial-with-gaps";
    case "meaningful":
    case "high":
      return "meaningful";
    case "repeatable-uncertain":
    case "repeatable_uncertain":
    case "uncertain":
    case "medium":
    default:
      return "repeatable-uncertain";
  }
}
