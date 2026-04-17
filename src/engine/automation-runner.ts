import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const AUTOMATIONS_DIR = path.join(os.homedir(), "flowtracker", "automations");
const LOGS_DIR = path.join(AUTOMATIONS_DIR, "logs");
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
  /** Present for "exit" events when spawn failed because the interpreter binary was not found. The UI uses this to offer a download link. */
  missingInterpreter?: "python" | "nodejs";
  /** Present for "exit" events — absolute path of the log file written to disk. */
  logFilePath?: string;
}

interface ActiveRun {
  runId: string;
  child: ChildProcess;
  outputBytes: number;
  timeoutHandle: NodeJS.Timeout;
  killed: boolean;
  /** Absolute path of the log file for this run. */
  logFilePath: string;
  /** Open write stream used to append output + the footer on exit. */
  logStream: fs.WriteStream;
  /** Walltime start, used to compute duration in the log footer. */
  startedAt: number;
  format: "python" | "nodejs";
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
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    /**
     * Parameter values to pass to the script. Each key becomes a
     * `--<name> <value>` CLI argument AND is exported as an env var named
     * FLOWMIND_PARAM_<NAME_UPPER>. This dual-channel makes it easy for the
     * generated script to read them whichever way the LLM chose (argparse,
     * os.getenv, etc.). Empty object → no params, no args, no env vars.
     */
    params: Record<string, string> = {},
    /**
     * Optional retry metadata — recorded in the run-log header so the user
     * (and any diff tool) can tell an auto-fix retry apart from a normal
     * run. `attempt` is 1 for the original run, 2+ for auto-fix retries.
     * `previousError` is a short summary of why the prior run failed.
     * `diagnosis` is the ScriptDoctor's one-paragraph explanation of what
     * it changed and why — persisted so the user can read it later.
     */
    retryMeta?: {
      attempt: number;
      previousError?: string;
      patchFromPath?: string;
      diagnosis?: string;
    }
  ): string {
    // Security: only run files that live inside ~/flowtracker/automations.
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(AUTOMATIONS_DIR))) {
      throw new Error(`Refusing to run file outside automations directory: ${filePath}`);
    }

    const command = pickCommand(format);
    const cwd = path.dirname(resolved);
    const runId = randomUUID();
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();

    // Build the final argv + env to hand to the child. Params go in BOTH
    // channels (flags and env vars) so the generated script can read them
    // using whichever API the LLM chose.
    const paramArgs: string[] = [];
    for (const [name, value] of Object.entries(params)) {
      paramArgs.push(`--${name}`, value);
    }
    const paramEnv: Record<string, string> = {};
    for (const [name, value] of Object.entries(params)) {
      const envKey = `FLOWMIND_PARAM_${name.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
      paramEnv[envKey] = value;
    }

    // Log file location: <automations>/logs/<script-slug>/<format>-<timestamp>.log.
    // We extract the flow-slug from the script filename, which follows
    // FlowStore.saveAutomation's "<slug>-<format>.<ext>" convention. For
    // auto-fix patches (`<slug>-<format>.v<N>.<ext>`) we strip the `.v<N>`
    // segment so retry runs land in the same "Previous runs" folder as the
    // primary script — otherwise the UI would split them into separate
    // per-version buckets and the retry chain becomes hard to follow.
    const scriptBaseRaw = path.basename(resolved).replace(/\.[a-z0-9]+$/i, "");
    const scriptBase = scriptBaseRaw.replace(/\.v\d+$/i, "");
    const logSubdir = path.join(LOGS_DIR, scriptBase);
    fs.mkdirSync(logSubdir, { recursive: true });
    const logFilePath = path.join(
      logSubdir,
      `${format}-${startedAtIso.replace(/[:.]/g, "-")}.log`
    );
    const logStream = fs.createWriteStream(logFilePath, { encoding: "utf-8" });
    const paramSummary = paramArgs.length > 0 ? ` ${paramArgs.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}` : "";
    logStream.write(
      [
        `# FlowMind automation run log`,
        `# script: ${resolved}`,
        `# format: ${format}`,
        `# command: ${command.bin} ${command.args.join(" ")} ${resolved}${paramSummary}`.trim(),
        `# cwd: ${cwd}`,
        `# started: ${startedAtIso}`,
        `# run_id: ${runId}`,
        ...(Object.keys(params).length > 0
          ? [`# params: ${JSON.stringify(params)}`]
          : []),
        ...(retryMeta
          ? [
              `# retry_attempt: ${retryMeta.attempt}`,
              ...(retryMeta.previousError
                ? [`# previous_error: ${retryMeta.previousError.replace(/\n/g, " ").slice(0, 500)}`]
                : []),
              ...(retryMeta.patchFromPath
                ? [`# patched_from: ${retryMeta.patchFromPath}`]
                : []),
              ...(retryMeta.diagnosis
                ? [`# diagnosis: ${retryMeta.diagnosis.replace(/\n/g, " ").slice(0, 1000)}`]
                : []),
            ]
          : []),
        ``,
        ``,
      ].join("\n")
    );

    const child = spawn(command.bin, [...command.args, resolved, ...paramArgs], {
      cwd,
      env: { ...process.env, ...paramEnv },
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
        const timeoutMsg = `\n[AutomationRunner] Timeout after ${Math.round(timeoutMs / 1000)}s — process killed.\n`;
        active.logStream.write(`[stderr] ${timeoutMsg}`);
        this.emitEvent({ runId, type: "output", stream: "stderr", data: timeoutMsg });
      }, timeoutMs),
      killed: false,
      logFilePath,
      logStream,
      startedAt,
      format,
    };
    this.runs.set(runId, active);

    const captureChunk = (stream: "stdout" | "stderr") => (chunk: Buffer | string) => {
      if (active.outputBytes >= MAX_OUTPUT_BYTES) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      const remaining = MAX_OUTPUT_BYTES - active.outputBytes;
      const truncated = text.length > remaining ? text.slice(0, remaining) + "\n[... output truncated — cap reached ...]\n" : text;
      active.outputBytes += truncated.length;
      // Prefix every line in the log so it's greppable outside the app.
      active.logStream.write(truncated.split("\n").map((l, i, arr) => (i < arr.length - 1 || l !== "") ? `[${stream}] ${l}` : l).join("\n"));
      this.emitEvent({ runId, type: "output", stream, data: truncated });
    };
    child.stdout?.on("data", captureChunk("stdout"));
    child.stderr?.on("data", captureChunk("stderr"));

    const finalize = (reason: RunEvent["reason"], code: number | null, error?: string) => {
      clearTimeout(active.timeoutHandle);
      this.runs.delete(runId);
      const endedAt = Date.now();
      const durationMs = endedAt - active.startedAt;
      active.logStream.write(
        [
          ``,
          `# ended: ${new Date(endedAt).toISOString()}`,
          `# duration_ms: ${durationMs}`,
          `# exit_code: ${code ?? "null"}`,
          `# reason: ${reason ?? "unknown"}`,
          ...(error ? [`# error: ${error.replace(/\n/g, " ")}`] : []),
          ``,
        ].join("\n")
      );
      active.logStream.end();

      const event: RunEvent = {
        runId,
        type: "exit",
        reason,
        code,
        logFilePath: active.logFilePath,
      };
      if (error) event.error = error;
      // Detect missing-interpreter (ENOENT on spawn) so the renderer can show
      // a download link for the right runtime.
      if (reason === "error" && error && /ENOENT/i.test(error)) {
        event.missingInterpreter = active.format;
      }
      this.emitEvent(event);
    };

    child.on("error", (err) => {
      finalize("error", null, err instanceof Error ? err.message : String(err));
    });

    child.on("exit", (code, signal) => {
      const reason: RunEvent["reason"] = active.killed
        ? (signal === "SIGKILL" ? "timeout" : "killed")
        : "completed";
      finalize(reason, code ?? null);
    });

    return runId;
  }

  /**
   * Install the given packages via `pip install` (python) or `npm install`
   * (nodejs). Streams output via the same "event" mechanism as run().
   *
   * Difference from run(): no .log file is persisted — installs are
   * ephemeral and do not belong in run history. The runId is still unique
   * so the UI can filter events to this install.
   *
   * Returns the runId. On ENOENT (pip/npm not found, e.g. Python/Node
   * missing) the exit event carries missingInterpreter so the UI can show
   * the same download link as a failed run.
   */
  installDeps(
    format: "python" | "nodejs",
    packages: string[],
    cwd: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    /**
     * Optional extra arguments spliced after the subcommand. Used for
     * `--user` on pip installs against a system Python we can't write
     * to without admin rights. Empty by default — ordinary in-project
     * installs don't need it.
     */
    extraArgs: string[] = []
  ): string {
    if (packages.length === 0) {
      throw new Error("installDeps called with empty package list");
    }
    const runId = randomUUID();
    const startedAt = Date.now();

    // Path safety: cwd must resolve inside the automations dir.
    const resolvedCwd = path.resolve(cwd);
    if (!resolvedCwd.startsWith(path.resolve(AUTOMATIONS_DIR))) {
      throw new Error(`Refusing to install outside automations directory: ${cwd}`);
    }

    const { bin, args } = pickInstallCommand(format, packages, extraArgs);
    const child = spawn(bin, args, {
      cwd: resolvedCwd,
      env: process.env,
      shell: false,
      windowsHide: true,
    });

    // Lightweight tracking — no log stream. We reuse the run map so kill()
    // works uniformly, but logFilePath is the empty string.
    const active: ActiveRun = {
      runId,
      child,
      outputBytes: 0,
      timeoutHandle: setTimeout(() => {
        active.killed = true;
        try { child.kill("SIGKILL"); } catch { /* gone */ }
        this.emitEvent({
          runId,
          type: "output",
          stream: "stderr",
          data: `\n[AutomationRunner] Install timeout after ${Math.round(timeoutMs / 1000)}s — aborted.\n`,
        });
      }, timeoutMs),
      killed: false,
      logFilePath: "",
      // A no-op write stream keeps the rest of the code uniform.
      logStream: fs.createWriteStream(require("os").devNull),
      startedAt,
      format,
    };
    this.runs.set(runId, active);

    const capture = (stream: "stdout" | "stderr") => (chunk: Buffer | string) => {
      if (active.outputBytes >= MAX_OUTPUT_BYTES) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      const remaining = MAX_OUTPUT_BYTES - active.outputBytes;
      const truncated = text.length > remaining ? text.slice(0, remaining) + "\n[... output truncated — cap reached ...]\n" : text;
      active.outputBytes += truncated.length;
      this.emitEvent({ runId, type: "output", stream, data: truncated });
    };
    child.stdout?.on("data", capture("stdout"));
    child.stderr?.on("data", capture("stderr"));

    const finalize = (reason: RunEvent["reason"], code: number | null, error?: string) => {
      clearTimeout(active.timeoutHandle);
      this.runs.delete(runId);
      try { active.logStream.end(); } catch { /* no-op */ }
      const event: RunEvent = { runId, type: "exit", reason, code };
      if (error) event.error = error;
      if (reason === "error" && error && /ENOENT/i.test(error)) {
        event.missingInterpreter = active.format;
      }
      this.emitEvent(event);
    };

    child.on("error", (err) => {
      finalize("error", null, err instanceof Error ? err.message : String(err));
    });

    child.on("exit", (code, signal) => {
      const reason: RunEvent["reason"] = active.killed
        ? (signal === "SIGKILL" ? "timeout" : "killed")
        : "completed";
      finalize(reason, code ?? null);
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

  /**
   * Write a line to a running process's stdin. The newline is appended so
   * Python's input() / Node's readline receive the complete input event.
   * Also echoes the written text to the runner's event stream so the UI's
   * output panel shows what the user typed (stdout shade, so it's clear the
   * string came from the user, not from the script).
   *
   * Returns true if the input was queued, false if the run is unknown or
   * its stdin has already been closed.
   */
  sendInput(runId: string, text: string): boolean {
    const active = this.runs.get(runId);
    if (!active) return false;
    const stdin = active.child.stdin;
    if (!stdin || stdin.destroyed) return false;
    try {
      stdin.write(`${text}\n`);
    } catch {
      return false;
    }
    // Mirror to log + UI so the transcript is readable ("> input text").
    const echo = `> ${text}\n`;
    try { active.logStream.write(`[stdin] ${echo}`); } catch { /* no-op for install runs */ }
    this.emit("event", { runId, type: "output", stream: "stdout", data: echo } satisfies RunEvent);
    return true;
  }

  /**
   * Close a running process's stdin (Ctrl-D equivalent). Useful when a
   * script reads until EOF (sys.stdin.read()).
   */
  closeStdin(runId: string): boolean {
    const active = this.runs.get(runId);
    if (!active) return false;
    const stdin = active.child.stdin;
    if (!stdin || stdin.destroyed) return false;
    try {
      stdin.end();
      return true;
    } catch {
      return false;
    }
  }

  private emitEvent(event: RunEvent): void {
    this.emit("event", event);
  }
}

function pickCommand(format: "python" | "nodejs"): { bin: string; args: string[] } {
  if (format === "python") {
    // -u: force unbuffered stdout/stderr. Without this, print() output can be
    // held in Python's buffers and only flushed at exit, which makes the live
    // output panel look broken and can hide input() prompts. input() itself
    // flushes its prompt, but the prevailing advice on piped stdin/stdout is
    // to always run with -u.
    //
    // On Windows, `python` is the conventional name via the py launcher or
    // PATH. On macOS/Linux, `python3` is the modern default — many systems
    // lack a `python` alias.
    if (process.platform === "win32") return { bin: "python", args: ["-u"] };
    return { bin: "python3", args: ["-u"] };
  }
  return { bin: "node", args: [] };
}

/**
 * Build the platform-correct `pip install` / `npm install` command. Matches
 * the interpreter conventions used by pickCommand so a user whose `python3`
 * resolves also has a `python3 -m pip`.
 */
function pickInstallCommand(
  format: "python" | "nodejs",
  packages: string[],
  extraArgs: string[] = []
): { bin: string; args: string[] } {
  if (format === "python") {
    // Use `python -m pip install` rather than calling `pip` directly — this
    // guarantees we install into the same interpreter we'll run the script
    // with. A machine with `pip3` pointing at a different Python than
    // `python3` (not uncommon on macOS) would otherwise break.
    //
    // `extraArgs` is where callers can inject `--user` for a system
    // Python install we can't write to without admin. Placing them
    // BEFORE the packages so `--user` applies to the whole install set.
    const bin = process.platform === "win32" ? "python" : "python3";
    return { bin, args: ["-m", "pip", "install", ...extraArgs, ...packages] };
  }
  // npm install <packages> — goes to the cwd's node_modules, which for us
  // is ~/flowtracker/automations. So the second Run uses the same modules.
  // extraArgs also applies here in case a future caller needs, e.g.,
  // --no-save or --prefer-offline.
  return { bin: "npm", args: ["install", ...extraArgs, ...packages] };
}
