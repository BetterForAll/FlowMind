import { GoogleGenAI } from "@google/genai";
import type { FlowWorth } from "../types";

/**
 * Full flow description fed to the worth judge. The judge is the hardest,
 * most value-dense decision in the pipeline — deciding whether an observed
 * activity is a meaningful automatable workflow versus noise dressed up as a
 * pattern. So we feed it the full detailed output of phase 2, not a summary.
 */
export interface FlowForJudgment {
  type: "complete-flow" | "partial-flow";
  name: string;
  trigger: string;
  /** Full steps markdown from phase 2. NOT truncated — the judge needs it all. */
  steps: string;
  apps: string[];
  occurrences: number;
  /** Average duration in minutes, if phase 2 reported one. */
  avgDurationMinutes?: number;
  /** Number of interview gaps remaining, if this is a partial flow. */
  gaps?: number;
  /** Optional — full decision-logic markdown from phase 2 if available. */
  decisionLogic?: string;
  /** Optional — full tools/data-sources markdown from phase 2 if available. */
  toolsAndData?: string;
  /** Optional — full automation-classification markdown from phase 2 if available. */
  automationClassification?: string;
  /** Optional — full variations markdown from phase 2 if available. */
  variations?: string;
}

export interface WorthVerdict {
  worth: FlowWorth;
  worth_reason: string;
  time_saved_estimate_minutes: number;
}

const WORTH_PROMPT = `You are FlowMind's worth judge. You are the most important classifier in the pipeline — everything downstream depends on your verdict. Your job is to decide whether a detected workflow is genuinely meaningful (worth automating / worth the user's interview time) or whether it is noise dressed up as a pattern.

Work through these five signals deliberately BEFORE arriving at a tier. You may think out loud internally — use your reasoning budget — but emit only the final JSON.

Signal 1 — Goal-directedness. Does the activity have an identifiable goal the user is trying to accomplish, or is it just "being active on the computer"? Saving a specific article with a specific filename to a specific folder = goal. Clicking between YouTube videos without any apparent purpose = no goal.

Signal 2 — Trigger concreteness. Is the trigger a specific circumstance that would recur ("when the user wants to save an article for later", "after finishing a meeting"), or is it vague ("sometimes"), or absent? A real workflow has a reproducible trigger, not an arbitrary one.

Signal 3 — Outcome concreteness. Does the activity produce a concrete, observable outcome (a file saved, a message sent, a form submitted, a calendar event created)? Or does it just end with the user moving on to something else? Noise has no outcome — or a trivial one like "the user closed the browser".

Signal 4 — Step structure. Do the steps form a recognizable sequence with clear dependencies (step B requires step A's output), or is it an arbitrary ordering of app-switches and clicks? Real workflows have structure. Noise is a list of disconnected actions.

Signal 5 — Repeatability. Is this something the user would plausibly do again? Signals of repeatability include: a routine nature (daily, weekly), a transferable shape (same structure with different content), a useful enough outcome that the user would want it again. One-off situational activity is not repeatable.

Assign one of these tiers:

- "noise": FAILS on goal-directedness or outcome-concreteness or repeatability. Not a workflow. Examples: jumping between unrelated YouTube videos, general browsing/scrolling without an outcome, opening and closing apps without producing anything, idle behavior. These must NOT be saved.
- "partial-with-gaps": workflow SHAPE is visible (goal, rough steps) but some critical steps, decisions, or the outcome are unclear. Has open interview questions. Cannot yet be reliably reproduced.
- "repeatable-uncertain": reproducible steps with a clear outcome, but the automation payoff is uncertain — either the steps are trivial to do manually (not worth automating), the trigger is not routine (unlikely to recur often), or the user's real intent is unclear from the observations. Save the flow but do not promote it as a top candidate.
- "meaningful": passes every signal. Clear goal, concrete trigger, concrete outcome, structured steps, plausible repeatability. Prime automation candidate. These are the flows the user should see first and the flows worth generating automations for.

Be HONEST. If the flow is noise, say noise — don't inflate to "repeatable-uncertain" to be nice. The downstream UI hides noise; inflating it pollutes the flow library.

Respond with ONLY valid JSON. The \`worth_reason\` must be ONE sentence that names the single strongest signal driving your verdict — not a description of the flow and not a hedge.

{
  "worth": "noise" | "partial-with-gaps" | "repeatable-uncertain" | "meaningful",
  "worth_reason": "One sentence naming the dominant signal."
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
    const duration = flow.avgDurationMinutes != null ? `${flow.avgDurationMinutes} min` : "unknown";

    const sections: string[] = [
      `## Flow to evaluate`,
      ``,
      `- name: ${flow.name}`,
      `- type: ${flow.type}`,
      `- trigger: ${flow.trigger || "(none given)"}`,
      `- apps: [${flow.apps.join(", ")}]`,
      `- occurrences observed: ${flow.occurrences}`,
      `- avg duration per occurrence: ${duration}`,
      ``,
      `### Steps`,
      flow.steps || "(none)",
    ];
    if (flow.decisionLogic) {
      sections.push(``, `### Decision logic`, flow.decisionLogic);
    }
    if (flow.toolsAndData) {
      sections.push(``, `### Tools & data sources`, flow.toolsAndData);
    }
    if (flow.automationClassification) {
      sections.push(``, `### Automation classification (from phase 2)`, flow.automationClassification);
    }
    if (flow.variations) {
      sections.push(``, `### Variations observed`, flow.variations);
    }

    const prompt = `${WORTH_PROMPT}\n\n${sections.join("\n")}\n`;

    const apiCall = this.genai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        // Worth judgment is the hardest call in the pipeline — a shallow verdict
        // defeats the point of classification. Always give the model reasoning
        // budget, regardless of the capture mode's default thinking setting.
        thinkingConfig: { thinkingBudget: 8192 },
      },
    });

    const response = await Promise.race([
      apiCall,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("WorthJudge timed out after 90s")), 90_000)
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
