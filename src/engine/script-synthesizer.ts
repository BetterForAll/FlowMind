import { GoogleGenAI } from "@google/genai";
import type { FlowDocument } from "../types";
import type { TraceStep } from "./agent-types";

/**
 * Trace → script. After the agent has successfully executed a flow by
 * calling tools, the synthesizer converts that tool-call trace into an
 * equivalent stand-alone python or Node.js script. The script becomes
 * the "fast path" artifact — the user can re-run without paying a full
 * agent-loop turn for every step next time.
 *
 * Design decisions:
 *
 * 1. LLM-based synthesis (not rule-based templates). The mapping from
 *    tool call → idiomatic script code is not 1:1 — sequences can be
 *    collapsed (three http_gets with paging → one loop), AI-judgement
 *    steps need embedded Gemini calls instead of baked-in answers,
 *    dependency choices depend on what's actually needed. A Gemini
 *    call handles these decisions naturally. Stage 1's ScriptDoctor
 *    provides the safety net if the synthesizer produces something
 *    that won't run.
 *
 * 2. AI-aware. The flow's "Automation Classification" section already
 *    distinguishes Deterministic / AI-required / Human-approval steps.
 *    The synthesizer honours that: deterministic steps collapse to
 *    stdlib calls, AI-required steps emit an LLM call with the same
 *    prompt the agent used live, human-approval steps emit
 *    ask_user-equivalent code (argparse --yes flag or a prompt line
 *    gated behind it, matching the convention in interview.ts).
 *
 * 3. Parameters preserved. Uses the same --name flag / FLOWMIND_PARAM_
 *    env-var convention as interview.ts's generator so the existing
 *    form-based Runner works with synthesized scripts unchanged.
 */

const SYNTHESIZER_PROMPT = `You are FlowMind's script synthesizer. You've been given a successful agent run: the flow's goal, the parameter values the agent received, and the full tool-call trace the agent produced (in order). Your job is to translate that trace into a stand-alone script that a machine can run later without the agent loop.

PRIMARY RULE — PREFER THE LIGHTEST EQUIVALENT.
- http_get(url) → urllib.request.urlopen(url) in Python; fetch(url) in Node.
- write_file(path, content) → pathlib.Path(path).write_text(content) / fs.writeFileSync.
- download_file → urllib.request.urlretrieve / streaming fetch + writeFile.
- desktop_dir / documents_dir → resolve at runtime via os.environ USERPROFILE + candidate subfolders (prefer OneDrive\\<name> if present). Do NOT hard-code any of the paths that appeared in the trace — they are THIS MACHINE's paths and the script must work on a fresh machine too.
- run_command → subprocess.run / child_process.spawn with check=True / error handling.
- browser_* → Playwright (Python: playwright.sync_api; Node: playwright). Only include browser code if the trace actually used browser tools. Prefer API/filesystem/stdlib equivalents when the trace's browser use was just to fetch a public URL that urllib/fetch could have fetched directly.
- ask_user → argparse flag matching the parameter name if the value was already supplied to the agent via params; otherwise add a new --<name> flag and document it in the usage line.

AI-REQUIRED STEPS:
If the flow's "Automation Classification" lists AI-required steps (summarise, pick-most-relevant, extract-structured-data, etc.) AND those steps were satisfied by the agent through reasoning over a tool result (not a deterministic call), you MUST emit an LLM call at that step in the synthesized script. The idiomatic shape:
  - Python: use google-generativeai (from google import genai; client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])). Call client.models.generate_content with the same prompt the agent used.
  - Node: use @google/genai. Same API.
  - Include fail-fast: print an instructive message and exit 2 if GEMINI_API_KEY is unset.

PARAMETERS:
Read from the "Parameter values supplied at run-time" section below. The host passes every parameter as --<name> <value> AND as FLOWMIND_PARAM_<NAME_UPPER> env var. Use argparse / process.argv. Do NOT use input() / readline for parameter values. Do NOT rename parameters — keep the exact names shown.

OTHER RULES:
- Never hard-code credentials. Read from environment.
- Include error handling for network + filesystem calls (try/except, check response status codes).
- Add a short module docstring at the top describing what the script does.
- Your response will be written to disk verbatim as the script — return ONLY the raw script source. No markdown, no code fences, no commentary.

Return the script now.`;

export interface SynthesizeInput {
  flow: FlowDocument;
  params: Record<string, string>;
  trace: TraceStep[];
  format: "python" | "nodejs";
  model: string;
}

export interface SynthesizeResult {
  /** The full script source, ready to write to disk. */
  source: string;
}

export class ScriptSynthesizer {
  private genai: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    this.genai = new GoogleGenAI({ apiKey });
  }

  async synthesize(input: SynthesizeInput): Promise<SynthesizeResult> {
    const traceSummary = this.formatTrace(input.trace);
    const prompt = [
      SYNTHESIZER_PROMPT,
      "",
      `## Target language`,
      input.format,
      "",
      `## Flow`,
      input.flow.body,
      "",
      `## Parameter values supplied at run-time`,
      this.formatParams(input.params),
      "",
      `## Agent trace (tool calls in order, one per step)`,
      traceSummary,
    ].join("\n");

    const apiCall = this.genai.models.generateContent({
      model: input.model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    const response = await Promise.race([
      apiCall,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("ScriptSynthesizer timed out after 90s")), 90_000)
      ),
    ]);

    let source = (response.text ?? "").trim();
    // Strip code fences if the model added them despite the prompt.
    source = source.replace(/^```[a-zA-Z0-9_-]*\s*/m, "").replace(/```\s*$/m, "").trim();
    if (source.length < 20) {
      throw new Error("ScriptSynthesizer produced an empty or near-empty script.");
    }
    // Parameter-name check: every supplied param name must still appear
    // somewhere in the source. Mirrors the guard in ScriptDoctor.
    for (const name of Object.keys(input.params)) {
      if (!source.includes(name)) {
        throw new Error(
          `Synthesized script is missing parameter "${name}" — cannot be run by the form runner.`
        );
      }
    }
    return { source };
  }

  private formatParams(params: Record<string, string>): string {
    if (Object.keys(params).length === 0) return "(none)";
    return Object.entries(params)
      .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
      .join("\n");
  }

  private formatTrace(trace: TraceStep[]): string {
    if (trace.length === 0) return "(empty trace — agent produced no tool calls)";
    // Truncate individual results to keep the prompt bounded. The
    // synthesizer doesn't need the full body of every HTTP response —
    // just enough to understand what the agent did with it.
    return trace
      .map((step) => {
        const argStr = JSON.stringify(step.args).slice(0, 400);
        const resStr = JSON.stringify(step.result).slice(0, 600);
        const err = step.error ? ` [error: ${step.error.slice(0, 200)}]` : "";
        return `${step.index}. ${step.name}(${argStr}) → ${resStr}${err}`;
      })
      .join("\n");
  }
}
