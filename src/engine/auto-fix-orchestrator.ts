import { EventEmitter } from "node:events";
import type { AutomationRunner, RunEvent } from "./automation-runner";
import type { FlowStore } from "./flow-store";
import { ScriptDoctor } from "./script-doctor";
import { detectExternalDeps } from "./dep-detector";

/**
 * Watches AutomationRunner runs for non-zero exits and — when the user has
 * auto-fix enabled — automatically invokes ScriptDoctor on the failure,
 * writes the patched script as a versioned sibling file, and starts a
 * retry run. The original script is never overwritten automatically.
 *
 * This class owns the "what should happen after a python/nodejs run fails"
 * policy. Keeping it out of AutomationRunner means the runner stays a
 * pure subprocess wrapper with no knowledge of LLMs, flows, or UI state.
 *
 * Emits two event types on itself (in addition to the raw runner events
 * which main.ts already forwards to the renderer):
 *   - "auto_fix_pending": a failed run has just been detected, the doctor
 *     is about to be invoked. Carries the same runId as the run that just
 *     exited. UI shows a "Diagnosing failure..." spinner in place of the
 *     completed run's final status.
 *   - "auto_fix_retry_started": a new retry run has been spawned. Carries
 *     the old runId, the new runId, attempt number, and the patch path.
 *     UI swaps its activeRun.runId to the new one.
 *   - "auto_fix_failed": the doctor could not produce a usable patch OR
 *     max retries have been exhausted. Carries the reason — rendered as
 *     a final error line in the output panel. No further retries will fire.
 */
export type AutoFixEvent =
  | { type: "auto_fix_pending"; runId: string; attempt: number; maxRetries: number }
  | {
      type: "auto_fix_retry_started";
      oldRunId: string;
      newRunId: string;
      attempt: number;
      maxRetries: number;
      patchPath: string;
      previousError: string;
      /** Doctor's explanation of what it changed and why, displayed to the
       *  user so they understand the patch without opening a diff tool. */
      diagnosis: string;
    }
  | { type: "auto_fix_failed"; runId: string; reason: string; attempt: number }
  | {
      /** A patched script succeeded and was automatically promoted to the
       *  primary slot. The UI should reload its automations list so the
       *  primary file reflects the new contents. */
      type: "auto_fix_promoted";
      patchPath: string;
      primaryPath: string;
      attempt: number;
    };

interface TrackedRun {
  flowId: string;
  flowName: string;
  flowBody: string;
  parameters: import("../types").FlowParameter[];
  filePath: string;
  format: "python" | "nodejs";
  params: Record<string, string>;
  attempt: number;
  /** Captured stdout for this run — fed to the doctor on failure. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** User opted out of auto-fix for this logical chain (e.g. clicked Disable). */
  disabled: boolean;
  /** Ext inferred from the file path — needed for writing versioned patches. */
  ext: string;
  /** Exit code of the last (failed) run; captured on the exit event so the
   * async auto-fix path has it. Null until the run has actually exited. */
  lastExitCode: number | null;
}

export class AutoFixOrchestrator extends EventEmitter {
  private runs = new Map<string, TrackedRun>();

  constructor(
    private runner: AutomationRunner,
    private store: FlowStore,
    private doctor: ScriptDoctor,
    /** Resolves the Gemini model to use for the doctor. */
    private modelResolver: () => Promise<string>,
    /** Resolves current config values. Called fresh on every failure. */
    private configResolver: () => Promise<{ enabled: boolean; maxRetries: number }>,
    /** Resolves flow metadata needed by the doctor by id. */
    private flowResolver: (flowId: string) => Promise<{
      name: string;
      body: string;
      parameters: import("../types").FlowParameter[];
    } | null>
  ) {
    super();
    this.runner.on("event", (ev: RunEvent) => {
      this.onRunnerEvent(ev);
    });
  }

  /**
   * Register a just-started run so we can handle its auto-fix if it fails.
   * Called from the IPC handler the moment a runId is returned by
   * AutomationRunner.run().
   */
  track(runId: string, input: Omit<TrackedRun, "stdout" | "stderr" | "disabled" | "lastExitCode">): void {
    this.runs.set(runId, {
      ...input,
      stdout: "",
      stderr: "",
      disabled: false,
      lastExitCode: null,
    });
  }

  /**
   * Opt out of auto-fix for the chain this runId belongs to. Used when the
   * user wants to see a failure raw (e.g. they're debugging the script).
   */
  disableForRun(runId: string): void {
    const r = this.runs.get(runId);
    if (r) r.disabled = true;
  }

  private onRunnerEvent(ev: RunEvent): void {
    const tracked = this.runs.get(ev.runId);
    if (!tracked) return;

    if (ev.type === "output" && ev.data) {
      if (ev.stream === "stderr") tracked.stderr += ev.data;
      else if (ev.stream === "stdout") tracked.stdout += ev.data;
      return;
    }

    if (ev.type === "exit") {
      const shouldFix =
        !tracked.disabled &&
        ev.reason === "completed" &&
        (ev.code ?? 0) !== 0 &&
        !ev.missingInterpreter;

      // The run is terminal from the runner's perspective either way — but we
      // DON'T untrack yet if we plan to retry, because the caller might want
      // to reference this tracked record to chain into a retry. We untrack
      // inside the async handler below, or immediately if we're done.
      if (!shouldFix) {
        // Auto-promote: a successful retry of a patched script means the
        // primary is broken and the patch works. Overwrite the primary with
        // the patch so the NEXT Run starts from the fixed version instead
        // of re-burning LLM calls to regenerate the same patch. Only fires
        // when the succeeded run was an auto-fix retry (attempt > 1),
        // which implies tracked.filePath points at a patch file.
        if (
          ev.reason === "completed" &&
          (ev.code ?? 0) === 0 &&
          tracked.attempt > 1
        ) {
          this.tryAutoPromote(tracked).catch((err) => {
            console.warn(
              "[AutoFix] auto-promote failed:",
              err instanceof Error ? err.message : err
            );
          });
        }
        this.runs.delete(ev.runId);
        return;
      }
      tracked.lastExitCode = ev.code ?? null;
      // Kick off async auto-fix. Errors inside are reported via event, never
      // rethrown — we are outside any request context here.
      this.tryAutoFix(ev.runId, tracked).catch((err) => {
        this.emit("event", {
          type: "auto_fix_failed",
          runId: ev.runId,
          reason: err instanceof Error ? err.message : String(err),
          attempt: tracked.attempt,
        } satisfies AutoFixEvent);
        this.runs.delete(ev.runId);
      });
    }
  }

  private async tryAutoFix(runId: string, tracked: TrackedRun): Promise<void> {
    const { enabled, maxRetries } = await this.configResolver();
    if (!enabled) {
      this.runs.delete(runId);
      return;
    }
    if (tracked.attempt > maxRetries) {
      this.emit("event", {
        type: "auto_fix_failed",
        runId,
        reason: `Auto-fix exhausted after ${tracked.attempt - 1} patch attempt(s). The script still fails.`,
        attempt: tracked.attempt,
      } satisfies AutoFixEvent);
      this.runs.delete(runId);
      return;
    }

    // Tell the UI we're diagnosing. This lets the UI keep the run panel
    // "alive" across the exit-new-run boundary with a spinner, instead of
    // flashing "✗ Exited" and then instantly replacing it.
    this.emit("event", {
      type: "auto_fix_pending",
      runId,
      attempt: tracked.attempt + 1,
      maxRetries,
    } satisfies AutoFixEvent);

    const flow = await this.flowResolver(tracked.flowId);
    if (!flow) {
      this.emit("event", {
        type: "auto_fix_failed",
        runId,
        reason: `Could not load flow ${tracked.flowId} for diagnosis.`,
        attempt: tracked.attempt,
      } satisfies AutoFixEvent);
      this.runs.delete(runId);
      return;
    }

    let originalScript: string;
    try {
      originalScript = await this.store.readAutomation(tracked.filePath);
    } catch (err) {
      this.emit("event", {
        type: "auto_fix_failed",
        runId,
        reason: `Could not read failed script: ${err instanceof Error ? err.message : String(err)}`,
        attempt: tracked.attempt,
      } satisfies AutoFixEvent);
      this.runs.delete(runId);
      return;
    }

    const model = await this.modelResolver();
    let patched: string;
    let diagnosis = "(no diagnosis available)";
    try {
      const result = await this.doctor.fix(
        {
          format: tracked.format,
          originalScript,
          stdout: tracked.stdout,
          stderr: tracked.stderr,
          exitCode: tracked.lastExitCode,
          flowBody: flow.body,
          parameters: flow.parameters,
          paramValues: tracked.params,
        },
        model
      );
      patched = result.patched;
      if (result.diagnosis) diagnosis = result.diagnosis;
    } catch (err) {
      this.emit("event", {
        type: "auto_fix_failed",
        runId,
        reason: `ScriptDoctor failed: ${err instanceof Error ? err.message : String(err)}`,
        attempt: tracked.attempt,
      } satisfies AutoFixEvent);
      this.runs.delete(runId);
      return;
    }

    // If the patched script adds external deps that weren't present before,
    // surface them in the failure message so the user knows to install.
    // This is cheap (regex scan of imports/requires) and catches the common
    // case where the doctor reaches for `requests` but it's not installed.
    const oldDeps = new Set(detectExternalDeps(originalScript, tracked.format));
    const newDeps = detectExternalDeps(patched, tracked.format).filter((d) => !oldDeps.has(d));
    if (newDeps.length > 0) {
      console.log(
        `[AutoFix] Patch introduces new external deps (${newDeps.join(", ")}) — user may need to install them.`
      );
    }

    let patchPath: string;
    try {
      patchPath = await this.store.saveAutomationPatch(
        flow.name,
        tracked.format,
        tracked.ext,
        patched
      );
    } catch (err) {
      this.emit("event", {
        type: "auto_fix_failed",
        runId,
        reason: `Could not write patch: ${err instanceof Error ? err.message : String(err)}`,
        attempt: tracked.attempt,
      } satisfies AutoFixEvent);
      this.runs.delete(runId);
      return;
    }

    // Build a short previousError summary for the log header and the UI
    // event — the doctor got the full text, but the UI needs a one-liner.
    const previousError = shortErrorSummary(tracked.stderr || tracked.stdout);

    let newRunId: string;
    try {
      newRunId = this.runner.run(
        patchPath,
        tracked.format,
        undefined,
        tracked.params,
        {
          attempt: tracked.attempt + 1,
          previousError,
          patchFromPath: tracked.filePath,
          diagnosis,
        }
      );
    } catch (err) {
      this.emit("event", {
        type: "auto_fix_failed",
        runId,
        reason: `Could not start retry run: ${err instanceof Error ? err.message : String(err)}`,
        attempt: tracked.attempt,
      } satisfies AutoFixEvent);
      this.runs.delete(runId);
      return;
    }

    // Register the retry so itself can be auto-fixed on failure.
    this.track(newRunId, {
      flowId: tracked.flowId,
      flowName: flow.name,
      flowBody: flow.body,
      parameters: flow.parameters,
      filePath: patchPath,
      format: tracked.format,
      params: tracked.params,
      attempt: tracked.attempt + 1,
      ext: tracked.ext,
    });

    this.emit("event", {
      type: "auto_fix_retry_started",
      oldRunId: runId,
      newRunId,
      attempt: tracked.attempt + 1,
      maxRetries,
      patchPath,
      previousError,
      diagnosis,
    } satisfies AutoFixEvent);

    // Old run is now fully handled.
    this.runs.delete(runId);
  }

  /**
   * Copy a patched script's contents into the primary slot and delete the
   * patch. Fires after a retry run has exited cleanly (exit 0). The next
   * user-initiated Run will then start from the fixed version — no further
   * LLM calls needed for the case that just got solved.
   */
  private async tryAutoPromote(tracked: TrackedRun): Promise<void> {
    // Defensive: the tracked filePath for a retry is a patch path
    // (<slug>-<format>.v<N>.<ext>). Only promote if the basename actually
    // matches that pattern — guards against a caller that accidentally
    // registers a non-retry run with attempt > 1.
    if (!/\.v\d+\.[a-z0-9]+$/i.test(tracked.filePath)) return;

    const primaryPath = await this.store.promotePatchToPrimary(tracked.filePath);
    this.emit("event", {
      type: "auto_fix_promoted",
      patchPath: tracked.filePath,
      primaryPath,
      attempt: tracked.attempt,
    } satisfies AutoFixEvent);
  }
}

/** Cheap last-line extraction for the short "previous error" summary. */
function shortErrorSummary(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "(no output)";
  // Prefer the last non-empty, non-"Traceback" line — that's usually the
  // actual error message. If nothing qualifies, fall back to last line.
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/^traceback/i.test(l)) continue;
    if (l.length < 4) continue;
    return l.slice(0, 200);
  }
  return lines[lines.length - 1].slice(0, 200);
}

