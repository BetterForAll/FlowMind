import { GoogleGenAI } from "@google/genai";
import type { DescriptionDocument } from "./description-store";
import type { FlowDocument } from "../types";

export interface GapAnswer {
  /** Zero-based index of the question this answer corresponds to. */
  questionIndex: number;
  /** The autonomous answer the judge gave. */
  answer: string;
  /** Brief pointer to the evidence in the new descriptions (a windowStart, a quote, etc). */
  evidence: string;
}

export interface GapClosureResult {
  answered: GapAnswer[];
  /** Question indexes that remain unanswered. */
  unanswered: number[];
}

const GAP_PROMPT = `You are FlowMind's gap-closer. Your job is to answer the open interview questions attached to a partial workflow using ONLY evidence from newly-captured observation narratives.

You will be given:
- A partial flow (its observed steps with [GAP] markers and a list of numbered questions).
- New observation narratives from a recent capture session.

For each question:
1. Determine whether the new narratives provide sufficient, specific evidence to answer it.
2. If yes, return a concise answer plus a short pointer to the evidence (e.g. a quoted phrase from the narrative, or the ISO windowStart of the source description).
3. If no, leave the question unanswered. Do NOT guess or invent details.

Be strict:
- Only return an answer when the narratives show concrete evidence the partial's question was asking about.
- A similar-sounding phrase is NOT evidence. The new narrative must actually show the user performing the step, making the decision, or producing the outcome the question asks about.
- If the narratives are about unrelated activity, return unanswered.

Respond with ONLY valid JSON in this exact shape:
{
  "answered": [
    {
      "question_index": 0,
      "answer": "Concise one-to-two sentence answer.",
      "evidence": "Short reference (e.g. quoted phrase or windowStart)."
    }
  ],
  "unanswered": [1, 2]
}

Every question must appear EXACTLY once — either in "answered" or in "unanswered" (by its index). Question indexes are zero-based and match the order of the "- Qn:" lines in the partial flow.`;

const SYNTHESIZE_PROMPT = `You are FlowMind. A partial workflow has had all of its interview gaps autonomously answered using new observation evidence. Convert the partial-flow body (with inline answers) into a complete flow document.

Output ONLY the markdown body (no frontmatter) following this exact structure:

# Flow Name

## Trigger
...

## Steps
1. Step (use IF/ELSE, FOR EACH where appropriate).

## Decision Logic
- condition: how the user decides.

## Tools & Data Sources
- App: read/write/both.

## Automation Classification
- Deterministic steps: list.
- AI-required steps: list + why.
- Human-approval-required: list + why.

## Variations Observed
- variation.

Do not include a "## Questions to Complete This Flow" section — all gaps are closed.`;

export class GapCloser {
  private genai: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    this.genai = new GoogleGenAI({ apiKey });
  }

  /**
   * Attempt to answer the open gap questions on a partial flow using evidence
   * from the given new descriptions. Every question from the partial is
   * returned in either `answered` or `unanswered`.
   *
   * Safe fallback: on any Gemini failure / timeout / malformed JSON, all
   * questions are returned as unanswered — identical to today's behaviour
   * where the user must answer via the UI.
   */
  async closeGaps(
    partial: FlowDocument,
    descriptions: DescriptionDocument[],
    model: string
  ): Promise<GapClosureResult> {
    const questions = extractQuestions(partial.body);
    if (questions.length === 0 || descriptions.length === 0) {
      return { answered: [], unanswered: questions.map((_, i) => i) };
    }

    try {
      return await this.callGemini(partial, questions, descriptions, model);
    } catch (err) {
      console.warn(`[GapCloser] Call failed for "${partial.frontmatter.name}" — leaving all gaps open:`, err);
      return { answered: [], unanswered: questions.map((_, i) => i) };
    }
  }

  /**
   * Synthesize a complete-flow markdown body from a partial-flow body whose
   * gaps have been filled with inline answers.
   */
  async synthesizeCompleteBody(
    bodyWithAnswers: string,
    model: string
  ): Promise<string> {
    const response = await this.genai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { text: SYNTHESIZE_PROMPT },
            { text: `\n\n## Partial flow with inline answers\n${bodyWithAnswers}` },
          ],
        },
      ],
    });
    const raw = (response.text ?? "").trim();
    return raw.replace(/^```(?:markdown)?\s*/i, "").replace(/```\s*$/, "").trim() || bodyWithAnswers;
  }

  private async callGemini(
    partial: FlowDocument,
    questions: string[],
    descriptions: DescriptionDocument[],
    model: string
  ): Promise<GapClosureResult> {
    const narrativesSection = descriptions
      .map((d) => `### windowStart: ${d.frontmatter.windowStart}\n${d.body}`)
      .join("\n\n---\n\n");

    const prompt = `${GAP_PROMPT}

## Partial flow

${partial.body}

## New observation narratives

${narrativesSection}`;

    const apiCall = this.genai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json" },
    });

    const response = await Promise.race([
      apiCall,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("GapCloser timed out after 60s")), 60_000)
      ),
    ]);

    let text = (response.text ?? "").trim();
    text = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    text = text.replace(/[\x00-\x1f\x7f]/g, (ch) =>
      ch === "\n" || ch === "\r" || ch === "\t" ? ch : ""
    );

    const parsed = JSON.parse(text) as {
      answered?: { question_index?: number; answer?: string; evidence?: string }[];
      unanswered?: number[];
    };

    // Normalize + validate: drop entries with out-of-range indexes, backfill
    // any missing indexes as unanswered, and ensure no index appears twice.
    const validRange = (n: unknown): n is number =>
      typeof n === "number" && Number.isInteger(n) && n >= 0 && n < questions.length;

    const answered: GapAnswer[] = [];
    const seen = new Set<number>();
    for (const a of parsed.answered ?? []) {
      if (!validRange(a.question_index)) continue;
      if (seen.has(a.question_index)) continue;
      const answer = (a.answer ?? "").trim();
      if (!answer) continue;
      answered.push({
        questionIndex: a.question_index,
        answer,
        evidence: (a.evidence ?? "").trim() || "(no evidence pointer given)",
      });
      seen.add(a.question_index);
    }

    const unanswered: number[] = [];
    for (let i = 0; i < questions.length; i++) {
      if (!seen.has(i)) unanswered.push(i);
    }

    return { answered, unanswered };
  }
}

/**
 * Extract the "- Qn: ..." lines from the partial-flow body. Returns the text
 * of each question in index order. Mirrors the parser used in InterviewEngine.
 */
export function extractQuestions(body: string): string[] {
  const out: string[] = [];
  const lines = body.split("\n");
  let inQuestions = false;
  for (const line of lines) {
    if (line.includes("## Questions to Complete This Flow")) {
      inQuestions = true;
      continue;
    }
    if (inQuestions && line.startsWith("##")) break;
    if (inQuestions && line.startsWith("- Q")) {
      out.push(line.replace(/^- Q\d+:\s*/, "").trim());
    }
  }
  return out;
}

/**
 * Insert answers inline under each "- Qn:" line that was closed, and rewrite
 * the "## Questions to Complete This Flow" section so it lists only the still-
 * unanswered questions, renumbered from Q1.
 *
 * Returns the new body text.
 */
export function insertAnswersAndRewriteQuestions(
  body: string,
  originalQuestions: string[],
  answered: GapAnswer[],
  unansweredIndexes: number[]
): string {
  const answerByIndex = new Map(answered.map((a) => [a.questionIndex, a]));
  const remaining = unansweredIndexes.map((i) => originalQuestions[i]);

  const lines = body.split("\n");
  const out: string[] = [];
  let inQuestions = false;
  let qCounter = 0;
  let newQuestionsEmitted = false;

  for (const line of lines) {
    if (line.includes("## Questions to Complete This Flow")) {
      inQuestions = true;
      out.push(line);
      // Emit the surviving questions in a fresh 1..N numbering, then inline-
      // record the ones we autonomously answered underneath the section.
      remaining.forEach((q, i) => out.push(`- Q${i + 1}: ${q}`));
      if (answered.length > 0) {
        out.push("");
        out.push("### Autonomously closed gaps");
        for (const a of answered) {
          out.push(`- Q (${originalQuestions[a.questionIndex]})`);
          out.push(`  **Answer:** ${a.answer}`);
          out.push(`  **Evidence:** ${a.evidence}`);
        }
      }
      newQuestionsEmitted = true;
      continue;
    }
    if (inQuestions) {
      if (line.startsWith("##")) {
        // Next section — stop skipping
        inQuestions = false;
        out.push(line);
      }
      // skip the old question lines
      continue;
    }
    out.push(line);
  }

  // Defensive: if the partial had no "## Questions" section at all (shouldn't
  // happen), but the caller still asked us to insert answers, append them.
  if (!newQuestionsEmitted && answered.length > 0) {
    out.push("");
    out.push("### Autonomously closed gaps");
    for (const a of answered) {
      out.push(`- Q (${originalQuestions[a.questionIndex]})`);
      out.push(`  **Answer:** ${a.answer}`);
      out.push(`  **Evidence:** ${a.evidence}`);
    }
  }

  // Silence the unused-counter warning; kept only to note the shape if we ever
  // want to re-introduce per-question stable numbering.
  void qCounter;

  return out.join("\n");
}
