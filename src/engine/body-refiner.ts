import { GoogleGenAI } from "@google/genai";

/**
 * Refine a complete-flow markdown body by reconciling the existing stored
 * version with a new observation of the same flow.
 *
 * Called from the matcher on a merge, AFTER evidence metadata is folded in.
 * The refiner's job is to produce a body that is strictly equal-or-better
 * than the existing one — covering both observed variants, noting the new
 * variation in "Variations Observed" if they differ, and without losing
 * useful detail that was in the existing body.
 *
 * Not called when the matcher decides a flow is new (there's no existing
 * body to reconcile against).
 */

const REFINER_PROMPT = `You are FlowMind's body refiner. Two observations of the same workflow exist: an already-saved "existing" version and a freshly-detected "new" version. Produce a single consolidated markdown body that preserves everything useful from the existing version AND folds in anything the new observation reveals.

STRICT RULES:
- Produce a markdown body only — NO frontmatter, NO triple-dash fences.
- The body must use the same section headings the existing version uses:
  # <Flow Name>
  ## Trigger
  ## Steps
  ## Decision Logic
  ## Tools & Data Sources
  ## Automation Classification
  ## Variations Observed
- PRESERVE detail from the existing version unless the new observation contradicts it. Do not simplify just to make it shorter. Detail that only appeared in one observation is still valid — it's a variation, not a regression.
- FOLD IN new behaviour that the existing version didn't capture. Examples: the existing says "saved to desktop", the new says "saved to a topic-named folder" — the refined version says "saved to desktop OR to a topic-named folder", and "Variations Observed" records both.
- PARAMETERISE when appropriate. If the existing version hard-codes a specific subject ("Octopus") and the new version uses a different one ("Claude Opus 4.7"), refer to the parameter abstractly (e.g. "[subject]") in Steps and record concrete examples in Variations Observed.
- DO NOT invent steps that appear in neither observation.
- DO NOT remove a step because the new observation didn't include it — it might just be an optional step. Mark optional steps as "IF ...".
- If the new observation is strictly a subset of the existing (same thing, less detail), keep the existing body unchanged.

Respond with ONLY the consolidated markdown body, starting with "# <Flow Name>" and ending with the last line of "Variations Observed". No code fences.`;

export class BodyRefiner {
  private genai: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    this.genai = new GoogleGenAI({ apiKey });
  }

  /**
   * Produce a refined body that reconciles the existing stored body with a
   * fresh detection. Returns the existing body unchanged on any failure —
   * never lossy.
   */
  async refine(
    existingBody: string,
    newDetection: {
      name: string;
      trigger: string;
      steps: string;
      decision_logic?: string;
      tools_and_data?: string;
      automation_classification?: string;
      variations?: string;
    },
    model: string
  ): Promise<string> {
    try {
      const newSection = [
        `# ${newDetection.name}`,
        ``,
        `## Trigger`,
        newDetection.trigger,
        ``,
        `## Steps`,
        newDetection.steps,
        `## Decision Logic`,
        newDetection.decision_logic ?? "",
        `## Tools & Data Sources`,
        newDetection.tools_and_data ?? "",
        `## Automation Classification`,
        newDetection.automation_classification ?? "",
        `## Variations Observed`,
        newDetection.variations ?? "",
      ].join("\n");

      const prompt = `${REFINER_PROMPT}\n\n## Existing stored body\n\n${existingBody}\n\n---\n\n## New observation (freshly detected)\n\n${newSection}`;

      const apiCall = this.genai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });

      const response = await Promise.race([
        apiCall,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("BodyRefiner timed out after 60s")), 60_000)
        ),
      ]);

      let refined = (response.text ?? "").trim();
      refined = refined.replace(/^```(?:markdown)?\s*/i, "").replace(/```\s*$/i, "").trim();

      // Sanity: a valid refined body must start with `# ` (heading). If the
      // model returned something unexpected, keep the original.
      if (!refined.startsWith("# ") || refined.length < 40) {
        console.warn(`[BodyRefiner] Returned unexpected body; keeping existing unchanged.`);
        return existingBody;
      }
      return refined;
    } catch (err) {
      console.warn(`[BodyRefiner] Refine failed; keeping existing body unchanged:`, err);
      return existingBody;
    }
  }
}
