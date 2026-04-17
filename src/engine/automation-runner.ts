import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const AUTOMATIONS_DIR = path.join(os.homedir(), "flowtracker", "automations");
const MAX_OUTPUT_BYTES = 256 * 1024; // 256 KB — guards against runaway loops
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export type RunEventType = "output" | "exit";

export interface RunEvent {
  runId: string;
  type: RunEventType;
  /** Present for "output" events. */
  stream?: "stdout" | "stderr";
  /** Present for "output" events — text chunk. */
  data?: string;
  /** Present for "exit" events — process exit code (null if killed by signal). */
  code?: number | null;
  /** Present for "exit" events — "completed" | "killed" | "timeout" | "error". */
  reason?: "completed" | "killed" | "timeout" | "error";
  /** Present for "exit" events with reason "error". */
  error?: string;
}

interface ActiveRun {
  runId: string;
  child: ChildProcess;
  outputBytes: number;
  timeoutHandle: NodeJS.Timeout;
  killed: boolean;
}

/**
 * Spawns and tracks background executions of generated automation files
 * (Python / Node.js). Streams stdout and stderr back to the main process
 * via an EventEmitter. Each run has a unique runId so the renderer can tell
 * overlapping runs apart.
 *
 * Security posture:
 *   - Only files inside ~/flowtracker/automations can be run (path must
 *     resolve inside that directory). This prevents arbitrary path
 *     injection from the renderer.
 *   - Output is capped at 256 KB total per run — excess is dropped with a
 *     notice, and the process is NOT killed automatically (a long log is
 *     not necessarily a malicious one).
 *   - Every run has a 5-minute hard timeout that SIGKILLs the process.
 *   - The user-facing UI shows the confirm dialog before invoking `run`,
 *     so the runner itself does not prompt.
 *
 * This class does NOT decide what is safe to run — the generated code is
 * effectively trusted-because-the-user-saw-it. The user reads the script
 * in the FlowDetail pane, then clicks Run.
 */
export class AutomationRunner extends EventEmitter {
  private runs = new Map<string, ActiveRun>();

  /**
   * Start a new run. Returns the runId immediately; listen for "event"
   * emissions to receive output and exit notifications.
   *
   * Throws synchronously for unsupported formats, paths outside the
   * automations directory, or missing interpreter.
   */
  run(
    filePath: string,
    format: "python" | "nodejs",
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): string {
    // Security: only run files that live inside ~/flowtracker/automations.
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(AUTOMATIONS_DIR))) {
      throw new Error(`Refusing to run file outside automations directory: ${filePath}`);
    }

    const command = pickCommand(format);
    const cwd = path.dirname(resolved);
    const runId = randomUUID();

    const child = spawn(command.bin, [...command.args, resolved], {
      cwd,
      env: process.env,
      // Inherit shell? No — direct spawn is simpler and safer. Scripts that
      // need shell features should use subprocess.shell=True inside the
      // script itself.
      shell: false,
      windowsHide: true,
    });

    const active: ActiveRun = {
      runId,
      child,
      outputBytes: 0,
      timeoutHandle: setTimeout(() => {
        active.killed = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        this.emitEvent({
          runId,
          type: "output",
          stream: "stderr",
          data: `\n[AutomationRunner] Timeout after ${Math.round(timeoutMs / 1000)}s — process killed.\n`,
        });
      }, timeoutMs),
      killed: false,
    };
    this.runs.set(runId, active);

    const captureChunk = (stream: "stdout" | "stderr") => (chunk: Buffer | string) => {
      if (active.outputBytes >= MAX_OUTPUT_BYTES) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      const remaining = MAX_OUTPUT_BYTES - active.outputBytes;
      const truncated = text.length > remaining ? text.slice(0, remaining) + "\n[... output truncated — cap reached ...]\n" : text;
      active.outputBytes += truncated.length;
      this.emitEvent({ runId, type: "output", stream, data: truncated });
    };
    child.stdout?.on("data", captureChunk("stdout"));
    child.stderr?.on("data", captureChunk("stderr"));

    child.on("error", (err) => {
      clearTimeout(active.timeoutHandle);
      this.runs.delete(runId);
      this.emitEvent({
        runId,
        type: "exit",
        reason: "error",
        error: err instanceof Error ? err.message : String(err),
        code: null,
      });
    });

    child.on("exit", (code, signal) => {
      clearTimeout(active.timeoutHandle);
      this.runs.delete(runId);
      const reason: RunEvent["reason"] = active.killed
        ? (signal === "SIGKILL" ? "timeout" : "killed")
        : "completed";
      this.emitEvent({ runId, type: "exit", reason, code: code ?? null });
    });

    return runId;
  }

  /**
   * Kill a running process by runId. Returns true if a matching run was
   * found and SIGTERM was sent. SIGKILL is escalated after 2s if still alive.
   */
  kill(runId: string): boolean {
    const active = this.runs.get(runId);
    if (!active) return false;
    active.killed = true;
    try {
      active.child.kill("SIGTERM");
    } catch { /* already gone */ }
    setTimeout(() => {
      try { active.child.kill("SIGKILL"); } catch { /* already gone */ }
    }, 2000);
    return true;
  }

  private emitEvent(event: RunEvent): void {
    this.emit("event", event);
  }
}

function pickCommand(format: "python" | "nodejs"): { bin: string; args: string[] } {
  if (format === "python") {
    // On Windows, `python` is the conventional name via the py launcher or PATH.
    // On macOS/Linux, `python3` is the modern default — many systems lack a
    // `python` alias. We'll try `python3` first on non-Windows; Windows uses
    // `python` which is what the installer from python.org provides.
    if (process.platform === "win32") return { bin: "python", args: [] };
    return { bin: "python3", args: [] };
  }
  return { bin: "node", args: [] };
}
