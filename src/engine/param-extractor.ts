import { GoogleGenAI } from "@google/genai";
import type { FlowParameter } from "../types";

/**
 * Extract the dynamic variables (parameters) a complete flow depends on.
 *
 * Called when a flow is first saved as complete, and re-called when a merge
 * produces a materially different body. The extractor's job: look at the
 * flow's steps + variations + evidence and identify the parts that would
 * change from run to run (topic name, file path, recipient, search query,
 * etc.), returning a structured list.
 *
 * The extractor does NOT classify parameters as fixed/rule/runtime —
 * classification is a later step driven by the interview or by user input
 * in the UI. Fresh parameters have kind=null, surfaced as
 * "needs classification" in the UI.
 */

const EXTRACTOR_PROMPT = `You are FlowMind's parameters extractor. You look at a documented workflow and identify the variables — the parts that would change from one run to the next.

Examples of what IS a parameter:
- The subject/topic of research ("Octopus" → "Claude Opus 4.7" → "Gemini 3.1 Pro")
- A file name or folder name derived from content
- A recipient of a message
- A search query
- A date range

Examples of what is NOT a parameter:
- The name of the app used (Chrome, Notepad) — that's fixed tooling
- Generic action verbs in steps ("click", "type", "save")
- Section headings

Guidelines:
- Prefer SHORT, canonical names ("subject", "folder", "recipient") over long ones.
- One parameter covers ONE concept, even if it shows up in multiple places. E.g. if the subject determines both the folder name and the file name, there's ONE parameter called "subject", not three.
- The "observed_values" list should be 1-5 concrete examples from the flow body (e.g. the subjects that appeared in Variations Observed).
- If a parameter is an obvious string derived FROM another parameter (e.g. filename = "<subject>-notes.txt"), describe the derivation in the parameter's description instead of creating two parameters.
- Return an empty list if the flow has no identifiable parameters (a fully scripted, content-free workflow).

Respond with ONLY valid JSON in this exact shape:

{
  "parameters": [
    {
      "name": "short_canonical_name",
      "description": "One sentence on what this represents and how it's used.",
      "observed_values": ["Example 1", "Example 2"]
    }
  ]
}

Every \`name\` must be a short lowercase-with-underscores identifier. The \`observed_values\` array may be empty if no concrete examples are visible in the flow body.`;

export class ParamExtractor {
  private genai: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    this.genai = new GoogleGenAI({ apiKey });
  }

  /**
   * Extract parameters from a complete flow's body. Returns an empty list
   * on failure — never lossy, the flow is still saved without parameters.
   */
  async extract(
    flowName: string,
    body: string,
    model: string
  ): Promise<FlowParameter[]> {
    try {
      const prompt = `${EXTRACTOR_PROMPT}\n\n## Flow\n\n### Name\n${flowName}\n\n### Body\n${body}`;
      const apiCall = this.genai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json" },
      });

      const response = await Promise.race([
        apiCall,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("ParamExtractor timed out after 45s")), 45_000)
        ),
      ]);

      let text = (response.text ?? "").trim();
      text = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
      text = text.replace(/[\x00-\x1f\x7f]/g, (ch) =>
        ch === "\n" || ch === "\r" || ch === "\t" ? ch : ""
      );

      const parsed = JSON.parse(text) as {
        parameters?: {
          name?: string;
          description?: string;
          observed_values?: string[];
        }[];
      };

      const out: FlowParameter[] = [];
      for (const p of parsed.parameters ?? []) {
        const name = (p.name ?? "").trim();
        if (!name) continue;
        if (!/^[a-z][a-z0-9_]*$/.test(name)) continue; // reject malformed identifiers
        const description = (p.description ?? "").trim();
        if (!description) continue;
        const observed = (p.observed_values ?? [])
          .map((v) => String(v).trim())
          .filter((v) => v.length > 0)
          .slice(0, 5);
        out.push({
          name,
          description,
          kind: null,
          observed_values: observed.length > 0 ? observed : undefined,
        });
      }
      return out;
    } catch (err) {
      console.warn(`[ParamExtractor] Extract failed for "${flowName}" — saving with no parameters:`, err);
      return [];
    }
  }
}
