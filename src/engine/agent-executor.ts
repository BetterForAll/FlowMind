import { GoogleGenAI, FunctionCallingConfigMode, type Content, type FunctionCall } from "@google/genai";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { FlowDocument } from "../types";
import type { AgentEvent, Tool, ToolContext, TraceStep } from "./agent-types";
import { CORE_TOOLS } from "./agent-tools";
import { BROWSER_TOOLS, closeBrowserSession, getOrCreateBrowser } from "./agent-browser";
import { DESKTOP_TOOLS, closeDesktopSession } from "./agent-desktop";
import { createVisionLocateTool } from "./agent-vision";

/**
 * Agent-first execution — the "live" runner. Instead of generating a
 * script and running it, the executor hands the flow's goal + observed
 * steps to Gemini as a system prompt and lets it drive the tools to
 * reach the outcome step by step. Every tool call is captured into a
 * trace; on success, the trace becomes the input for the script
 * synthesizer (which emits a replay script for the fast path).
 *
 * Why this beats pre-generated scripts (Stage 2's motivation):
 *   - OneDrive-redirected Desktop: `desktop_dir()` resolves at runtime.
 *   - Search-vs-direct-URL: agent can try direct, see 404, fall back to
 *     search; one pre-generated script locks in the wrong assumption.
 *   - Missing parameter values: `ask_user` bridges to the UI instead of
 *     the agent hallucinating a flag name.
 *
 * Limits:
 *   - Max 30 steps per run (configurable below). After that we emit
 *     `agent_finished` with success=false.
 *   - Max 5 consecutive tool errors — if the agent keeps trying broken
 *     approaches we stop rather than grind through all 30 steps.
 *   - Single browser session per run, closed at the end.
 */

const MAX_STEPS = 30;
const MAX_CONSECUTIVE_ERRORS = 5;

const SYSTEM_PROMPT = `You are FlowMind's agent runner. You execute a previously-observed workflow by calling tools until the goal is reached.

How to think:
- The flow body below describes what the user did manually (open browser, click, type). You are not replaying keystrokes — you are AUTOMATING THE GOAL.
- Prefer the lightest tool: filesystem > HTTP > browser. For example, to download a Wikipedia article, use http_get (or download_file), NOT browser_open + browser_click.
- Use browser tools only when the task genuinely requires a browser (auth, CAPTCHA, JS-rendered content not available via API).
- Call desktop_dir / documents_dir / home_dir rather than guessing paths. On Windows, OneDrive-redirected folders are common.
- Parameters supplied by the user are available in the PARAMETERS section below. Use them exactly as given. Do NOT ask_user for values that are already there.
- ask_user is reserved for values the flow needs that are not in parameters AND not discoverable from the observation.
- After each tool call, inspect the result. If a step failed, try a different approach (e.g. 404 on direct URL → search; ENOENT → resolve the path via the right tool).
- When the goal has been reached, stop calling tools. Your final reply should be a short plain-text summary of what you did.

Safety:
- Never perform destructive actions (delete_file, sending messages, committing payments) without asking the user first via ask_user.
- Stay within the scope of the described flow. Don't make tangential changes.

Now read the flow and execute it.`;

export interface AgentRunInput {
  flow: FlowDocument;
  params: Record<string, string>;
  /** Model to use for the agent loop. */
  model: string;
  /** Bridge to the renderer's user-prompt UI. Same contract as the
   *  one Stage 1's auto-fix uses — resolves with the answer string. */
  askUser: (runId: string, prompt: string, kind: "text" | "yesno" | "choice", choices?: string[]) => Promise<string>;
  /** Optional runId — if omitted, generated here. Used so the caller
   *  can hand it to the UI before the agent starts emitting events. */
  runId?: string;
  /** Tool tier the agent has access to:
   *   - 1 (default): filesystem, HTTP, subprocess, browser (Playwright)
   *   - 2: everything in 1 PLUS desktop UI Automation + vision_locate
   *
   * Level 2 is opt-in because desktop control can be destructive. The UI
   * surfaces it as the "Run with All Tools" button. */
  level?: 1 | 2;
  /** When true, Level 2 tool calls pause and ask the user to approve
   *  before executing. Has no effect at Level 1 (no destructive tools).
   *  Surfaced as a checkbox in the agent-mode UI. */
  approveEachStep?: boolean;
  /** When true, the agent's chromium browser launches in headed mode so
   *  the user can watch each navigate/click happen live. Defaults to
   *  headless — the agent's job is normally to be invisible. */
  headedBrowser?: boolean;
}

export interface AgentRunResult {
  runId: string;
  success: boolean;
  reason: string;
  /** Full tool-call trace — input for the synthesizer. */
  trace: TraceStep[];
  /** Final plain-text summary from the model, when it stopped cleanly. */
  finalText?: string;
}

export class AgentExecutor extends EventEmitter {
  private genai: GoogleGenAI;

  constructor() {
    super();
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    this.genai = new GoogleGenAI({ apiKey });
  }

  /**
   * Build the tool registry for a given level. Stage 3 adds desktop +
   * vision tools when level=2; the executor calls this once per run so
   * a single AgentExecutor instance can serve runs at either level
   * without leaking declarations between them.
   */
  private buildToolRegistry(level: 1 | 2, model: string): Record<string, Tool> {
    const base = { ...CORE_TOOLS, ...BROWSER_TOOLS };
    if (level < 2) return base;
    // Vision needs the model name so it can call the same multimodal
    // endpoint the executor uses; instantiated per-run for isolation.
    return { ...base, ...DESKTOP_TOOLS, vision_locate: createVisionLocateTool(model) };
  }

  /** Tool names whose effects could damage the user's machine — every
   *  call to one of these is gated behind the approve-each-step prompt
   *  when that mode is on. Pure-read tools (window_list, screen_screenshot)
   *  are intentionally NOT in this list — pausing on every screenshot
   *  would make the agent unusable. */
  private static readonly DESTRUCTIVE_TOOLS = new Set([
    "control_click",
    "control_type",
    "keyboard_send",
    "mouse_click_at",
    "app_launch",
    "window_focus",
  ]);

  /**
   * Run the agent against a flow. Emits `agent_*` events along the way
   * (see agent-types.ts). Does NOT throw on tool errors — the agent
   * sees them and reacts. Throws only on catastrophic failure (bad flow
   * input, Gemini unreachable). Always closes the browser session on
   * exit, success or failure.
   */
  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const runId = input.runId ?? randomUUID();
    const trace: TraceStep[] = [];
    const level: 1 | 2 = input.level ?? 1;
    const approveEachStep = !!input.approveEachStep;

    this.emitEvent({ type: "agent_started", runId, flowId: input.flow.frontmatter.id });

    const ctx: ToolContext = {
      runId,
      flowBody: input.flow.body,
      params: input.params,
      askUser: (prompt, kind, choices) => input.askUser(runId, prompt, kind, choices),
      // Closure binds the headed flag at executor entry — the in-tool
      // ctx.getBrowser() signature stays no-arg so individual tool
      // implementations don't have to know about display preferences.
      getBrowser: () => getOrCreateBrowser({ headed: !!input.headedBrowser }),
    };

    const tools = this.buildToolRegistry(level, input.model);

    // Function declarations handed to Gemini. Rebuilt once at the start
    // of every run (cheap — they're just objects). Cast through unknown
    // because our ToolDeclaration.properties is typed as Record<string,
    // unknown> (we don't mirror the full @google/genai Schema type in the
    // tool definitions to keep them readable) — Gemini's schema at this
    // depth is structurally compatible.
    const functionDeclarations = Object.values(tools).map(
      (t) => t.declaration
    ) as unknown as import("@google/genai").FunctionDeclaration[];

    // Seed the conversation. The initial user turn holds everything the
    // agent needs to orient: the flow body, the current parameter values,
    // and a reminder of the primary rule.
    const contents: Content[] = [
      {
        role: "user",
        parts: [
          { text: SYSTEM_PROMPT },
          { text: `\n\n## Flow\n${input.flow.body}` },
          { text: `\n\n## Parameters (already collected from user)\n${this.formatParams(input.params)}` },
        ],
      },
    ];

    let consecutiveErrors = 0;
    let finalText: string | undefined;

    try {
      for (let step = 1; step <= MAX_STEPS; step++) {
        const res = await this.genai.models.generateContent({
          model: input.model,
          contents,
          config: {
            tools: [{ functionDeclarations }],
            toolConfig: {
              functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
            },
          },
        });

        const calls: FunctionCall[] = res.functionCalls ?? [];
        const modelText = res.text?.trim() ?? "";

        if (calls.length === 0) {
          // No more tool calls — the agent is done talking. We treat this
          // as success. The final text is the agent's summary.
          finalText = modelText || "(agent produced no final summary)";
          this.emitEvent({ type: "agent_thinking", runId, text: finalText });
          break;
        }

        // Append the model's turn verbatim — required for the next turn
        // to understand its own prior reasoning.
        const modelContent = res.candidates?.[0]?.content;
        if (modelContent) contents.push({ role: modelContent.role ?? "model", parts: modelContent.parts ?? [] });

        // Dispatch each tool call in sequence (preserves ordering for the
        // trace). Could parallelise, but ordering matters more than speed
        // here — the agent often issues one call at a time anyway.
        const responseParts: Content["parts"] = [];
        for (const call of calls) {
          const index = trace.length + 1;
          const name = call.name ?? "<unknown>";
          const args = (call.args ?? {}) as Record<string, unknown>;
          this.emitEvent({ type: "agent_step_started", runId, index, name, args });

          const tool = tools[name];
          const startedAt = Date.now();
          let result: Record<string, unknown>;
          let error: string | undefined;

          if (!tool) {
            error = `Unknown tool: ${name}`;
            result = { error };
          } else {
            // Approval gate: when approveEachStep is on AND the tool is
            // in the destructive set, ask the user before executing.
            // Read tools (window_list, screenshot, etc.) skip the gate
            // — pausing on every screen capture would make the agent
            // unusable.
            let approvalDenied = false;
            if (
              approveEachStep &&
              AgentExecutor.DESTRUCTIVE_TOOLS.has(name)
            ) {
              try {
                const summary = `${name}(${JSON.stringify(args).slice(0, 200)})`;
                const answer = await ctx.askUser(
                  `Approve this step?\n\n${summary}`,
                  "yesno"
                );
                if (answer !== "yes") {
                  approvalDenied = true;
                  error = "Step denied by user.";
                  result = { error };
                  consecutiveErrors++;
                }
              } catch (err) {
                approvalDenied = true;
                error = `Approval prompt failed: ${err instanceof Error ? err.message : err}`;
                result = { error };
                consecutiveErrors++;
              }
            }

            if (!approvalDenied) {
              try {
                result = await tool.invoke(args, ctx);
                consecutiveErrors = 0;
              } catch (err) {
                error = err instanceof Error ? err.message : String(err);
                result = { error };
                consecutiveErrors++;
              }
            } else {
              // result already set above to the error stub.
              result = result!;
            }
          }

          const durationMs = Date.now() - startedAt;
          trace.push({ index, name, args, result, error, durationMs });
          this.emitEvent({
            type: "agent_step_finished",
            runId,
            index,
            name,
            result,
            error,
            durationMs,
          });

          responseParts.push({
            functionResponse: { name, response: result },
          });
        }

        // Feed all tool responses back as a single user turn.
        contents.push({ role: "user", parts: responseParts });

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          this.emitEvent({
            type: "agent_finished",
            runId,
            success: false,
            reason: `Aborted: ${MAX_CONSECUTIVE_ERRORS} consecutive tool errors.`,
            trace,
          });
          return {
            runId,
            success: false,
            reason: `Aborted after ${MAX_CONSECUTIVE_ERRORS} consecutive tool errors.`,
            trace,
          };
        }
      }

      if (!finalText) {
        this.emitEvent({
          type: "agent_finished",
          runId,
          success: false,
          reason: `Aborted: hit the ${MAX_STEPS}-step ceiling without finishing.`,
          trace,
        });
        return {
          runId,
          success: false,
          reason: `Hit the ${MAX_STEPS}-step ceiling without the agent declaring completion.`,
          trace,
        };
      }

      this.emitEvent({
        type: "agent_finished",
        runId,
        success: true,
        reason: "Agent completed the flow.",
        trace,
      });
      return { runId, success: true, reason: "Completed.", trace, finalText };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitEvent({ type: "agent_error", runId, error: msg });
      this.emitEvent({
        type: "agent_finished",
        runId,
        success: false,
        reason: `Executor crashed: ${msg}`,
        trace,
      });
      return {
        runId,
        success: false,
        reason: `Executor crashed: ${msg}`,
        trace,
      };
    } finally {
      // Always close the browser — it's a heavyweight resource and leaking
      // between runs causes mysterious second-run failures.
      await closeBrowserSession();
      // Same for the Python desktop helper. Kills the subprocess if one
      // was spawned; no-op if the run never reached Level 2.
      closeDesktopSession();
    }
  }

  private formatParams(params: Record<string, string>): string {
    if (Object.keys(params).length === 0) return "(none supplied)";
    return Object.entries(params)
      .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
      .join("\n");
  }

  private emitEvent(ev: AgentEvent): void {
    this.emit("event", ev);
  }
}
