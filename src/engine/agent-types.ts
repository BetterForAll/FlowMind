/**
 * Shared types for the agent-execution layer (Stage 2 of the automation
 * roadmap). Kept in its own module so both the runtime (agent-executor,
 * agent-tools) and the synthesizer (trace → script) can import without
 * pulling in unrelated engine modules.
 */

import type { Type } from "@google/genai";

/**
 * A single tool-call + result in the agent's execution trace. After a
 * successful run, the trace is the canonical artifact the synthesizer
 * converts into a reusable script.
 *
 * Each record captures EVERYTHING the synthesizer needs to emit equivalent
 * code: the call name + args (so the synthesizer can pick the right code
 * template), the result (so it knows which branch the agent took), and
 * whether the step involved LLM judgement (so the synthesized script keeps
 * an LLM call at that step rather than baking the one-time answer).
 */
export interface TraceStep {
  /** Sequential index, 1-based. Stable across retries of the same step. */
  index: number;
  /** Registered tool name (e.g. "http_get", "browser_click"). */
  name: string;
  /** The args the model passed to the tool. Preserved verbatim. */
  args: Record<string, unknown>;
  /** The tool's return value. Truncated for very large payloads so traces
   *  don't blow up, but the critical parts (status codes, paths, text) stay. */
  result: Record<string, unknown>;
  /** Set when a tool invocation threw. Recorded so the trace still tells
   *  the whole story — including failed attempts the agent recovered from. */
  error?: string;
  /** Wall-clock duration of the tool call, milliseconds. */
  durationMs: number;
  /** True if this step's outcome came from an LLM judgement call the agent
   *  made (e.g. "summarize this page", "pick the most relevant result").
   *  The synthesizer keeps an LLM call in the emitted script for these
   *  steps instead of baking in the one-time answer. */
  aiJudgement?: boolean;
}

/**
 * Event emitted by the executor as the agent runs. Mirrors the existing
 * `automations:event` pattern — main forwards these to the renderer over
 * a dedicated channel so the UI's live trace view can render each step
 * as it happens.
 */
export type AgentEvent =
  | { type: "agent_started"; runId: string; flowId: string }
  | { type: "agent_step_started"; runId: string; index: number; name: string; args: Record<string, unknown> }
  | { type: "agent_step_finished"; runId: string; index: number; name: string; result: Record<string, unknown>; error?: string; durationMs: number }
  | { type: "agent_thinking"; runId: string; text: string }
  | { type: "agent_asking_user"; runId: string; promptId: string; prompt: string; kind: "text" | "yesno" | "choice"; choices?: string[] }
  | { type: "agent_finished"; runId: string; success: boolean; reason: string; trace: TraceStep[] }
  | { type: "agent_error"; runId: string; error: string }
  /** Synthesized script has been saved as the flow's primary automation
   *  for the target format. Fires after a successful agent run when the
   *  caller asked for synthesis. */
  | { type: "agent_trace_saved"; runId: string; filePath: string; format: "python" | "nodejs" }
  /** Synthesis failed (e.g. Gemini returned a script missing parameter
   *  names). The agent run itself succeeded — the replay script is just
   *  unavailable. Users can still rerun via agent mode. */
  | { type: "agent_synthesize_failed"; runId: string; reason: string };

/**
 * Tool declaration — the shape the executor registers with Gemini. Kept
 * minimal so adding a new tool is a single object.
 */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: {
    type: Type.OBJECT;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Context passed to every tool invocation. Holds runtime dependencies the
 * tool needs but shouldn't pull in globally (the askUser bridge to the
 * renderer, the browser session for Playwright tools, the flow body for
 * recall_observation).
 */
export interface ToolContext {
  /** Run id — used when emitting agent events from inside a tool. */
  runId: string;
  /** Markdown body of the flow being executed — used by recall_observation. */
  flowBody: string;
  /** Parameter values supplied by the user for this run. Agent reads from
   *  this rather than re-asking through ask_user when the value is already
   *  known up front. */
  params: Record<string, string>;
  /** Bridge to the renderer's user-prompt UI. Resolves with the answer
   *  string (yes/no mapped to "yes" / "no", choice mapped to the selected
   *  option). Rejects if the user cancels the run. */
  askUser: (prompt: string, kind: "text" | "yesno" | "choice", choices?: string[]) => Promise<string>;
  /** Lazy-initialised browser session — see agent-browser.ts. Tools that
   *  need it call `getBrowser()` which opens chromium on first use and
   *  returns the singleton page thereafter. Closed at run end by the
   *  executor. */
  getBrowser: () => Promise<import("playwright").Page>;
}

/**
 * Tool implementation — returned by the registry. The executor looks the
 * tool up by name, runs `invoke` with the args Gemini passed, and wraps
 * the return value into a functionResponse part for the next turn.
 */
export interface Tool {
  declaration: ToolDeclaration;
  /** Invoke the tool. Throws on recoverable failure — the executor catches
   *  and feeds the error back to the model as a functionResponse with an
   *  `error` field, so the agent can try another approach. */
  invoke: (args: Record<string, unknown>, ctx: ToolContext) => Promise<Record<string, unknown>>;
}
