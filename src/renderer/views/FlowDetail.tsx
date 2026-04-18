import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { FlowDocument, InterviewQuestion, AutomationFile, FlowWorth, FlowParameter } from "../../types";
import type { DescriptionDocument } from "../../engine/description-store";
import type { RunLogEntry } from "../../engine/flow-store";

const INTERPRETER_DOWNLOADS: Record<"python" | "nodejs", { label: string; url: string }> = {
  python: { label: "python.org/downloads", url: "https://www.python.org/downloads/" },
  nodejs: { label: "nodejs.org", url: "https://nodejs.org/" },
};

function worthLabel(worth: FlowWorth | undefined): string {
  switch (worth) {
    case "meaningful":         return "Worth automating";
    case "repeatable-uncertain": return "Full workflow — uncertain automation value";
    case "partial-with-gaps":  return "Partial workflow — needs clarification";
    default:                   return "Unclassified";
  }
}

/**
 * Extract CLI parameter names a script declares — the actual runtime source
 * of truth for what --flags it will accept. Regex-scans for "--name" token
 * occurrences in the script content; this catches Python argparse
 * (add_argument("--subject", ...)) and Node.js patterns that mention the
 * flag in help text or error messages ("missing --subject").
 *
 * Standard operational flags (--help, --version, --yes) are filtered out
 * so they don't show up as parameter fields.
 */
function detectCliParamsFromScript(content: string): string[] {
  const seen = new Set<string>();
  const STANDARD = new Set(["help", "version", "yes", "no", "quiet", "verbose", "dry-run"]);
  const re = /--([a-zA-Z][a-zA-Z0-9_-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    if (STANDARD.has(name.toLowerCase())) continue;
    seen.add(name);
  }
  return Array.from(seen).sort();
}

function paramKindLabel(kind: FlowParameter["kind"]): { label: string; color: string } {
  switch (kind) {
    case "fixed":   return { label: "Fixed",   color: "rgba(148, 163, 184, 0.9)" };
    case "rule":    return { label: "Rule",    color: "rgba(129, 140, 248, 0.95)" };
    case "runtime": return { label: "Runtime", color: "rgba(52, 211, 153, 0.95)" };
    default:        return { label: "Needs classification", color: "rgba(251, 191, 36, 0.95)" };
  }
}

function encodePath(p: string): string {
  return `flowmind://file/${encodeURIComponent(p.replace(/\\/g, "/"))}`;
}

/**
 * Collapse large tool-call results for the agent trace viewer. Some tool
 * results (HTTP bodies, browser_extract_text) can be hundreds of KB —
 * rendering all of that inline makes the panel unusable. The full result
 * is still in the trace and the saved log; this is a display-only trim.
 */
function truncateForDisplay(s: string): string {
  const MAX = 400;
  return s.length > MAX ? s.slice(0, MAX) + "…" : s;
}

/**
 * Turn a programmatic parameter name (`articleSubject`, `article_subject`,
 * `article-subject`) into a human-readable label ("Article Subject"). Used
 * for the parameter form so the user sees prose, with the raw flag name
 * shown smaller next to it as the source-of-truth identifier.
 */
function humanizeParamName(name: string): string {
  return name
    // Split camelCase: "articleSubject" → "article Subject"
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // Underscores and dashes become spaces
    .replace(/[_-]+/g, " ")
    // Collapse whitespace and Title-Case each word
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

type AutomationFormat = "python" | "nodejs" | "claude-skill" | "tutorial";

const FORMAT_TABS: { key: AutomationFormat; label: string }[] = [
  { key: "python", label: "Python" },
  { key: "nodejs", label: "Node.js" },
  { key: "claude-skill", label: "Claude Skill" },
  { key: "tutorial", label: "Tutorial" },
];

// Static usage hint for Claude Skill — the file itself stays clean, so this is
// the only place the install steps live. For other formats, we overwrite with
// the backend-generated `usage` string on first generation.
const CLAUDE_SKILL_USAGE = [
  "**How to use this as a Claude Code skill**",
  "",
  "1. Copy this file into the `.claude/skills/` folder of any project where you want to use it",
  "2. The skill will be auto-discovered by Claude Code next time you open that project",
  "3. Invoke it by typing `/<skill-name>` in the Claude Code chat (skill-name comes from the YAML `name` field)",
].join("\n");

interface FlowDetailProps {
  flowId: string;
  onBack: () => void;
  onDataChanged: () => void;
}

export function FlowDetail({ flowId, onBack, onDataChanged }: FlowDetailProps) {
  const [flow, setFlow] = useState<FlowDocument | null>(null);
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  // Per-format state: the current file (if any), its loaded content, and usage hint
  const [automationsByFormat, setAutomationsByFormat] = useState<Record<string, AutomationFile>>({});
  const [automationContent, setAutomationContent] = useState<Record<string, string>>({});
  const [usageByFormat, setUsageByFormat] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<AutomationFormat>("python");
  const [sources, setSources] = useState<DescriptionDocument[]>([]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [keyScreenshotsByFile, setKeyScreenshotsByFile] = useState<Record<string, string[]>>({});
  // Run-automation state — one active run per automation format at a time.
  const [activeRun, setActiveRun] = useState<{ runId: string; format: AutomationFormat; kind: "run" | "install" } | null>(null);
  const [runOutput, setRunOutput] = useState<{ stream: "stdout" | "stderr"; data: string }[]>([]);
  const [runStatus, setRunStatus] = useState<"idle" | "running" | "installing" | "completed" | "killed" | "timeout" | "error">("idle");
  const [runExitCode, setRunExitCode] = useState<number | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runMissingInterpreter, setRunMissingInterpreter] = useState<"python" | "nodejs" | null>(null);
  const [runLogs, setRunLogs] = useState<Record<string, RunLogEntry[]>>({});
  const [selectedLogContent, setSelectedLogContent] = useState<string | null>(null);
  const [selectedLogPath, setSelectedLogPath] = useState<string | null>(null);
  // External (non-stdlib / non-builtin) deps detected in each format's script.
  const [externalDeps, setExternalDeps] = useState<Record<string, string[]>>({});
  const [stdinDraft, setStdinDraft] = useState("");
  const stdinInputRef = useRef<HTMLInputElement>(null);
  // Parameter form state — filled in before Run, passed as CLI args to
  // the script. One draft map per flow; keys are the parameter names.
  const [paramDraft, setParamDraft] = useState<Record<string, string>>({});
  const [paramFormOpen, setParamFormOpen] = useState(false);
  /** Ref to the first param input — focused by an effect when the form
   *  opens so the user can start typing immediately without clicking.
   *  Defends against focus theft from late-arriving panels (stale agent
   *  prompts, run-output stdin) that compete for focus on render. */
  const firstParamInputRef = useRef<HTMLInputElement>(null);
  // Auto-fix progress across a chain of retries. `phase` drives the visible
  // status; `attempt` is 1-indexed (1 = original run, 2+ = auto-fix retries).
  // `diagnosis` is the doctor's most recent explanation; `previousError` is
  // the short one-liner extracted from the prior run's stderr — rendered in
  // the panel so the user can see exactly what the doctor was reacting to.
  const [autoFixState, setAutoFixState] = useState<{
    phase: "idle" | "diagnosing" | "retrying" | "exhausted" | "disabled";
    attempt: number;
    maxRetries: number;
    patchPath: string | null;
    reason: string | null;
    diagnosis?: string | null;
    previousError?: string | null;
  }>({ phase: "idle", attempt: 1, maxRetries: 0, patchPath: null, reason: null, diagnosis: null, previousError: null });
  // Params used on the current run chain — kept so the UI can show what
  // values the latest retry was invoked with (values are held in main
  // between retries; this mirror is purely informational).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_lastRunParams, setLastRunParams] = useState<Record<string, string>>({});
  // Agent-mode (Stage 2) state. Separate from activeRun because agent
  // runs don't go through the subprocess-based AutomationRunner.
  interface AgentStep {
    index: number;
    name: string;
    args: Record<string, unknown>;
    result?: Record<string, unknown>;
    error?: string;
    durationMs?: number;
  }
  const [agentRun, setAgentRun] = useState<
    | null
    | {
        runId: string;
        format: AutomationFormat;
        status: "running" | "success" | "failed" | "synthesizing" | "saved";
        reason?: string;
        finalText?: string;
        synthesizedPath?: string;
      }
  >(null);
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([]);
  const [agentPrompt, setAgentPrompt] = useState<
    | null
    | {
        promptId: string;
        prompt: string;
        kind: "text" | "yesno" | "choice";
        choices?: string[];
      }
  >(null);
  const [agentPromptAnswer, setAgentPromptAnswer] = useState("");
  /** If set, the parameter form's "Run with these values" should fire
   *  the AGENT (not the script runner) for this format. Cleared when
   *  the agent kicks off or the form is dismissed. */
  const [pendingAgentFormat, setPendingAgentFormat] = useState<"python" | "nodejs" | null>(null);
  /** Stage 3 — when set, the next agent kick-off uses Level 2 (desktop
   *  + vision tools enabled). Cleared after launch or dismissal. */
  const [pendingAgentLevel, setPendingAgentLevel] = useState<1 | 2>(1);
  /** User toggle: pause and ask before every destructive Level 2 tool
   *  call. Visible only when Level 2 is engaged. Defaulted to TRUE —
   *  Level 2 drives real mouse/keyboard on the live desktop, and the
   *  user has only confirmed they trust the FLOW, not any specific
   *  step the agent will take. They can tick this off if they want
   *  full speed once they've watched a few runs go cleanly. (Will be
   *  replaced by per-flow trust graduation in a follow-up.) */
  const [approveEachStep, setApproveEachStep] = useState(true);
  /** Cached desktop-helper readiness probe. null = unknown until first
   *  click; refreshed on demand. */
  const [desktopReady, setDesktopReady] = useState<
    | null
    | {
        ready: boolean;
        pythonAvailable: boolean;
        missing: string[];
      }
  >(null);
  /** True while the install IPC is running so the install banner can
   *  show a spinner. Cleared by the run-event subscription when the pip
   *  install subprocess exits. */
  const [installingDesktopDeps, setInstallingDesktopDeps] = useState(false);
  /** When the user clicked "Run with All Tools" but the readiness probe
   *  failed and we kicked off an install, this remembers the
   *  AutomationFile they wanted to run so we can resume the launch
   *  automatically the moment the install succeeds. Without it, the
   *  user has to click "Run with All Tools" a second time after install
   *  — confusing because they expressed the intent only once. */
  const [pendingLevel2Launch, setPendingLevel2Launch] = useState<AutomationFile | null>(null);
  /** Per-run preference: launch the agent's chromium browser visible
   *  (headed) so the user can watch what the agent does. Default off
   *  — agents are usually meant to be invisible. Toggled by the
   *  "Show browser" checkbox that appears in the param form when an
   *  agent run is queued. */
  const [headedBrowser, setHeadedBrowser] = useState(false);
  /** Controls the collapsible "What do these modes do?" info panel
   *  rendered above the Run button group. Lets the user compare the
   *  four modes side-by-side without hover-tooltip whack-a-mole. */
  const [runModesInfoOpen, setRunModesInfoOpen] = useState(false);
  /** Smart Run mode — when true, the renderer auto-escalates: tries the
   *  script first (with Stage 1 auto-fix), and if all patches exhaust,
   *  falls through to an agent run automatically. The user just clicks
   *  one button; the trail of attempts streams into the live panel. */
  const [smartRunMode, setSmartRunMode] = useState(false);
  /** Mirror of pendingAgentFormat for Smart Run — needed because the
   *  parameter-form submit handler has to know which orchestrator to
   *  invoke once params are filled. */
  const [pendingSmartRunFormat, setPendingSmartRunFormat] = useState<"python" | "nodejs" | null>(null);
  /** Visible breadcrumb of which layers Smart Run has tried this round.
   *  Rendered above the run panel so the user can see "Script failed →
   *  Auto-fix exhausted → Running as agent…" without parsing the log. */
  const [smartRunTrail, setSmartRunTrail] = useState<string[]>([]);
  /** Last params used in this Smart Run chain — needed because the
   *  agent-escalation step has to re-issue the run with the same values
   *  the user originally submitted. */
  const [smartRunParams, setSmartRunParams] = useState<Record<string, string>>({});

  const loadAutomations = useCallback(async (flowName: string) => {
    const list = await window.flowmind.listAutomationsForFlow(flowName) as AutomationFile[];
    const map: Record<string, AutomationFile> = {};
    for (const a of list) map[a.format] = a;
    setAutomationsByFormat(map);
    // Preload content for whichever formats have files
    for (const a of list) {
      try {
        const body = await window.flowmind.readAutomation(a.filePath) as string;
        setAutomationContent((prev) => ({ ...prev, [a.format]: body }));
      } catch (err) {
        console.error("Failed to read automation:", err);
      }
    }
  }, []);

  useEffect(() => {
    (async () => {
      const f = await window.flowmind.getFlowById(flowId);
      setFlow(f);
      if (f?.frontmatter.type === "partial-flow") {
        const qs = await window.flowmind.getQuestions(flowId);
        setQuestions(qs);
      }
      if (f?.frontmatter.type === "complete-flow") {
        await loadAutomations(f.frontmatter.name);
      }
      // Load source descriptions if this flow has linkage
      const windowStarts = f?.frontmatter.source_windows ?? [];
      if (windowStarts.length > 0) {
        const docs = await window.flowmind.getDescriptionsByWindowStarts(windowStarts) as DescriptionDocument[];
        docs.sort(
          (a, b) =>
            new Date(a.frontmatter.windowStart).getTime() -
            new Date(b.frontmatter.windowStart).getTime()
        );
        setSources(docs);
      } else {
        setSources([]);
      }
    })();
  }, [flowId, loadAutomations]);

  const toggleSources = () => setSourcesOpen((v) => !v);

  const loadKeyScreenshotsFor = async (doc: DescriptionDocument) => {
    if (keyScreenshotsByFile[doc.filePath]) return;
    if (doc.frontmatter.keyScreenshotCount === 0) return;
    const paths = await window.flowmind.getDescriptionKeyScreenshots(doc.filePath) as string[];
    setKeyScreenshotsByFile((prev) => ({ ...prev, [doc.filePath]: paths }));
  };

  useEffect(() => {
    if (!sourcesOpen) return;
    for (const doc of sources) {
      loadKeyScreenshotsFor(doc);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesOpen, sources]);

  // Fetch previous run logs for the current flow + active tab format.
  const reloadLogsForFormat = useCallback(async (flowName: string, format: AutomationFormat) => {
    if (format !== "python" && format !== "nodejs") return;
    try {
      const entries = (await window.flowmind.listRunLogs(flowName, format)) as RunLogEntry[];
      setRunLogs((prev) => ({ ...prev, [format]: entries }));
    } catch (err) {
      console.error("Failed to list run logs:", err);
    }
  }, []);

  // Fetch the external (non-stdlib / non-builtin) deps declared by the script.
  const reloadExternalDeps = useCallback(async (filePath: string, format: AutomationFormat) => {
    if (format !== "python" && format !== "nodejs") return;
    try {
      const deps = (await window.flowmind.getExternalDeps(filePath, format)) as string[];
      setExternalDeps((prev) => ({ ...prev, [format]: deps }));
    } catch (err) {
      console.error("Failed to detect external deps:", err);
    }
  }, []);

  useEffect(() => {
    if (flow?.frontmatter.type === "complete-flow") {
      reloadLogsForFormat(flow.frontmatter.name, activeTab);
      const a = automationsByFormat[activeTab];
      if (a) reloadExternalDeps(a.filePath, activeTab);
    }
  }, [flow, activeTab, automationsByFormat, reloadLogsForFormat, reloadExternalDeps]);

  // Explicit focus management for the stdin input. `autoFocus` alone isn't
  // enough — it only fires on first mount, and anything that steals focus
  // (confirm dialog, clicking output, clicking Send) permanently pulls focus
  // away. This effect focuses the input when a run transitions into
  // "running". useEffect runs AFTER React commits the DOM, so the ref is
  // populated by then — no setTimeout needed.
  useEffect(() => {
    if (runStatus === "running" && activeRun?.kind === "run") {
      stdinInputRef.current?.focus();
    }
  }, [runStatus, activeRun]);

  // Same idea for the parameter form: when it opens, focus the first
  // input immediately so the user can type without first clicking. Also
  // clear any stale agent ask_user prompt — its autoFocus input would
  // otherwise grab focus on the next render and leave the form looking
  // unresponsive even though it's clearly visible.
  useEffect(() => {
    if (paramFormOpen) {
      setAgentPrompt(null);
      firstParamInputRef.current?.focus();
    }
  }, [paramFormOpen]);

  // Subscribe to automation run events once on mount.
  useEffect(() => {
    interface RunEvent {
      runId: string;
      type: "output" | "exit";
      stream?: "stdout" | "stderr";
      data?: string;
      code?: number | null;
      reason?: "completed" | "killed" | "timeout" | "error";
      error?: string;
      missingInterpreter?: "python" | "nodejs";
      logFilePath?: string;
    }
    const unsubscribe = window.flowmind.onAutomationEvent((raw: unknown) => {
      const event = raw as RunEvent;
      // Use a functional setState so we can filter by the current activeRun's id
      // without needing activeRun as a dep. Stale runs are ignored.
      setActiveRun((current) => {
        if (!current || event.runId !== current.runId) return current;
        if (event.type === "output" && event.data && event.stream) {
          setRunOutput((prev) => [...prev, { stream: event.stream!, data: event.data! }]);
          return current;
        }
        if (event.type === "exit") {
          setRunStatus(event.reason ?? "completed");
          setRunExitCode(event.code ?? null);
          if (event.error) setRunError(event.error);
          if (event.missingInterpreter) setRunMissingInterpreter(event.missingInterpreter);
          // Reload the log list so the new run appears in "Previous runs" —
          // but only for actual runs, since installs don't write log files.
          if (current.kind === "run" && flow?.frontmatter.name) {
            reloadLogsForFormat(flow.frontmatter.name, current.format);
          }
          // If an install just finished cleanly, refresh the dep list so the
          // Install prompt hides on successful install.
          if (current.kind === "install" && event.reason === "completed" && event.code === 0) {
            const a = automationsByFormat[current.format];
            if (a) reloadExternalDeps(a.filePath, current.format);
            // If the desktop-deps install was the one in flight, re-probe
            // readiness so the install banner clears, AND auto-continue
            // the Run-with-All-Tools launch the user originally requested.
            // Without the auto-continue the user would have to click the
            // button again — confusing because they already expressed
            // intent once.
            if (installingDesktopDeps) {
              setInstallingDesktopDeps(false);
              (async () => {
                const s = (await window.flowmind.checkDesktopReady()) as {
                  ready: boolean;
                  pythonAvailable: boolean;
                  missing: string[];
                };
                setDesktopReady(s);
                if (s.ready && pendingLevel2Launch) {
                  const target = pendingLevel2Launch;
                  setPendingLevel2Launch(null);
                  // Defer to next tick so the readiness state commit
                  // before the relaunch reads it.
                  setTimeout(() => startAgentRunWithAllTools(target, true), 0);
                }
              })();
            }
          } else if (current.kind === "install" && installingDesktopDeps) {
            // Install failed/timed-out — keep the banner up so the user
            // sees what happened. Clear the in-flight flag and abandon
            // any pending auto-launch (the user can retry manually).
            setInstallingDesktopDeps(false);
            setPendingLevel2Launch(null);
          }
          return null; // run is done
        }
        return current;
      });
    });
    return unsubscribe;
  }, [flow, automationsByFormat, reloadLogsForFormat, reloadExternalDeps, installingDesktopDeps, pendingLevel2Launch]);

  // Subscribe to auto-fix events (main-side orchestration). These ride a
  // separate channel from the raw runner events so they're easy to filter.
  useEffect(() => {
    interface AutoFixPending {
      type: "auto_fix_pending";
      runId: string;
      attempt: number;
      maxRetries: number;
    }
    interface AutoFixRetryStarted {
      type: "auto_fix_retry_started";
      oldRunId: string;
      newRunId: string;
      attempt: number;
      maxRetries: number;
      patchPath: string;
      previousError: string;
      diagnosis: string;
    }
    interface AutoFixFailed {
      type: "auto_fix_failed";
      runId: string;
      reason: string;
      attempt: number;
    }
    interface AutoFixPromoted {
      type: "auto_fix_promoted";
      patchPath: string;
      primaryPath: string;
      attempt: number;
    }
    type Ev = AutoFixPending | AutoFixRetryStarted | AutoFixFailed | AutoFixPromoted;

    const unsubscribe = window.flowmind.onAutoFixEvent((raw: unknown) => {
      const ev = raw as Ev;
      if (ev.type === "auto_fix_pending") {
        setAutoFixState({
          phase: "diagnosing",
          attempt: ev.attempt,
          maxRetries: ev.maxRetries,
          patchPath: null,
          reason: null,
        });
        // Keep the run panel visible; don't reset runStatus here. The
        // prior run's "exit" event will have set it to "completed" or
        // similar — we override the header rendering based on phase.
        setRunOutput((prev) => [
          ...prev,
          {
            stream: "stdout",
            data: `\n[auto-fix] Run failed — invoking ScriptDoctor (attempt ${ev.attempt}/${ev.maxRetries + 1})...\n`,
          },
        ]);
        return;
      }
      if (ev.type === "auto_fix_retry_started") {
        setAutoFixState({
          phase: "retrying",
          attempt: ev.attempt,
          maxRetries: ev.maxRetries,
          patchPath: ev.patchPath,
          reason: null,
          diagnosis: ev.diagnosis,
          previousError: ev.previousError,
        });
        // Switch the active run to the new runId. Keep the prior output so
        // the user can scroll up and see what the original run did before
        // the retry was spawned.
        setActiveRun((curr) => {
          const format = curr?.format ?? (ev.patchPath.endsWith(".py") ? "python" : "nodejs");
          return { runId: ev.newRunId, format, kind: "run" };
        });
        setRunStatus("running");
        setRunExitCode(null);
        setRunError(null);
        setRunOutput((prev) => [
          ...prev,
          {
            stream: "stdout",
            data:
              `\n[auto-fix] Diagnosis: ${ev.diagnosis}\n` +
              `[auto-fix] Patched script saved to ${ev.patchPath}\n` +
              `[auto-fix] Retrying (attempt ${ev.attempt}/${ev.maxRetries + 1})...\n`,
          },
        ]);
        return;
      }
      if (ev.type === "auto_fix_failed") {
        setAutoFixState((prev) => ({
          ...prev,
          phase: "exhausted",
          reason: ev.reason,
        }));
        setRunOutput((prevOut) => [
          ...prevOut,
          { stream: "stderr", data: `\n[auto-fix] ${ev.reason}\n` },
        ]);
        // Smart Run escalation: if we got here because Smart Run was
        // active and Stage 1 auto-fix gave up, transparently start an
        // agent run with the same parameters. Done with a setTimeout(0)
        // so React commits this auto-fix update first; otherwise the
        // agent's first event would race the auto-fix terminal state.
        if (smartRunMode && activeTab && (activeTab === "python" || activeTab === "nodejs")) {
          setSmartRunTrail((prev) => [...prev, "Auto-fix exhausted — escalating to agent…"]);
          setTimeout(() => {
            kickOffAgentRun(activeTab, smartRunParams);
          }, 0);
        }
        return;
      }
      if (ev.type === "auto_fix_promoted") {
        // The patch has become the new primary — clear the patchPath so
        // the "Promote patch" button hides, and reload the automations
        // list so the UI reads the fresh primary contents on next view.
        setAutoFixState((prev) => ({ ...prev, patchPath: null }));
        setRunOutput((prevOut) => [
          ...prevOut,
          {
            stream: "stdout",
            data: `\n[auto-fix] Patch promoted to primary: ${ev.primaryPath}\n[auto-fix] Next Run starts from the fixed version.\n`,
          },
        ]);
        if (flow?.frontmatter.name) {
          loadAutomations(flow.frontmatter.name);
        }
        return;
      }
    });
    return unsubscribe;
  }, [flow, loadAutomations]);

  // Agent-mode event subscription (Stage 2). Drives the live trace view
  // and the ask_user prompt modal.
  useEffect(() => {
    type Ev =
      | { type: "agent_started"; runId: string; flowId: string }
      | {
          type: "agent_step_started";
          runId: string;
          index: number;
          name: string;
          args: Record<string, unknown>;
        }
      | {
          type: "agent_step_finished";
          runId: string;
          index: number;
          name: string;
          result: Record<string, unknown>;
          error?: string;
          durationMs: number;
        }
      | { type: "agent_thinking"; runId: string; text: string }
      | {
          type: "agent_asking_user";
          runId: string;
          promptId: string;
          prompt: string;
          kind: "text" | "yesno" | "choice";
          choices?: string[];
        }
      | { type: "agent_finished"; runId: string; success: boolean; reason: string; trace: unknown[] }
      | { type: "agent_error"; runId: string; error: string }
      | { type: "agent_trace_saved"; runId: string; filePath: string; format: "python" | "nodejs" }
      | { type: "agent_synthesize_failed"; runId: string; reason: string };

    const unsubscribe = window.flowmind.onAgentEvent((raw: unknown) => {
      const ev = raw as Ev;
      setAgentRun((curr) => {
        if (!curr || ev.runId !== curr.runId) return curr;

        if (ev.type === "agent_step_started") {
          setAgentSteps((prev) => [
            ...prev,
            { index: ev.index, name: ev.name, args: ev.args },
          ]);
        } else if (ev.type === "agent_step_finished") {
          setAgentSteps((prev) =>
            prev.map((s) =>
              s.index === ev.index
                ? { ...s, result: ev.result, error: ev.error, durationMs: ev.durationMs }
                : s
            )
          );
        } else if (ev.type === "agent_thinking") {
          return { ...curr, finalText: ev.text };
        } else if (ev.type === "agent_asking_user") {
          setAgentPrompt({
            promptId: ev.promptId,
            prompt: ev.prompt,
            kind: ev.kind,
            choices: ev.choices,
          });
          setAgentPromptAnswer("");
        } else if (ev.type === "agent_finished") {
          // Smart Run lifecycle: agent is the last layer for now (Level 2
          // doesn't exist yet). Whichever way it ended, the chain is over.
          if (smartRunMode) {
            setSmartRunTrail((prev) => [
              ...prev,
              ev.success ? "Agent succeeded — Smart Run complete." : `Agent failed: ${ev.reason}`,
            ]);
            setSmartRunMode(false);
          }
          // Defensive: clear any in-flight ask_user prompt. Without this,
          // a prompt that the agent posted but never resolved (e.g. agent
          // crashed before answer) would linger and steal focus from the
          // next form/run via its autoFocus input.
          setAgentPrompt(null);
          return {
            ...curr,
            status: ev.success ? (curr.synthesizedPath ? "saved" : "synthesizing") : "failed",
            reason: ev.reason,
          };
        } else if (ev.type === "agent_error") {
          if (smartRunMode) {
            setSmartRunTrail((prev) => [...prev, `Agent crashed: ${ev.error}`]);
            setSmartRunMode(false);
          }
          setAgentPrompt(null);
          return { ...curr, status: "failed", reason: ev.error };
        } else if (ev.type === "agent_trace_saved") {
          if (flow?.frontmatter.name) loadAutomations(flow.frontmatter.name);
          if (smartRunMode) {
            setSmartRunTrail((prev) => [...prev, `Replay script saved → next Smart Run starts cheap.`]);
          }
          return { ...curr, status: "saved", synthesizedPath: ev.filePath };
        } else if (ev.type === "agent_synthesize_failed") {
          return { ...curr, status: "failed", reason: `Synthesis failed: ${ev.reason}` };
        }
        return curr;
      });
    });
    return unsubscribe;
  }, [flow, loadAutomations]);

  const viewLog = async (entry: RunLogEntry) => {
    try {
      const content = (await window.flowmind.readRunLog(entry.filePath)) as string;
      setSelectedLogContent(content);
      setSelectedLogPath(entry.filePath);
    } catch (err) {
      console.error("Failed to read log:", err);
    }
  };

  const deleteLog = async (entry: RunLogEntry) => {
    if (!confirm(`Delete log ${entry.filename}? This cannot be undone.`)) return;
    try {
      await window.flowmind.deleteRunLog(entry.filePath);
      if (selectedLogPath === entry.filePath) {
        setSelectedLogContent(null);
        setSelectedLogPath(null);
      }
      if (flow?.frontmatter.name) {
        await reloadLogsForFormat(flow.frontmatter.name, activeTab);
      }
    } catch (err) {
      console.error("Failed to delete log:", err);
    }
  };

  const submitAllAnswers = async () => {
    const unanswered = questions.filter((q) => !q.answered);
    const allFilled = unanswered.every((q) => answers[q.index]?.trim());
    if (!allFilled) return;

    setSubmitting(true);
    try {
      const result = await window.flowmind.submitAllAnswers(flowId, answers);
      if (result.promoted) {
        onDataChanged();
        onBack();
      } else if (result.newQuestions) {
        // Gemini found more gaps — show new follow-up questions
        setQuestions(result.newQuestions);
        setAnswers({});
      }
    } finally {
      setSubmitting(false);
    }
  };

  const generateAutomation = async (format: AutomationFormat, isRegenerate: boolean) => {
    if (isRegenerate) {
      const ok = confirm(`Replace the existing ${format} automation for this flow?`);
      if (!ok) return;
    }
    setGenerating(true);
    setGenerateError(null);
    try {
      const result = await window.flowmind.generateAutomation(flowId, format);
      if (flow) await loadAutomations(flow.frontmatter.name);
      setAutomationContent((prev) => ({ ...prev, [format]: result.content }));
      setUsageByFormat((prev) => ({ ...prev, [format]: result.usage }));
      setActiveTab(format);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setGenerateError(message);
      console.error("[FlowMind] Automation generation failed:", err);
    } finally {
      setGenerating(false);
    }
  };

  const openAutomation = async (a: AutomationFile) => {
    try { await window.flowmind.openAutomation(a.filePath); } catch (err) {
      console.error("Open failed:", err);
    }
  };

  const revealAutomation = async (a: AutomationFile) => {
    try { await window.flowmind.revealAutomation(a.filePath); } catch (err) {
      console.error("Reveal failed:", err);
    }
  };

  const copyAutomation = async (format: AutomationFormat) => {
    const body = automationContent[format];
    if (!body) return;
    await navigator.clipboard.writeText(body);
  };

  const runAutomation = async (a: AutomationFile, paramsOverride?: Record<string, string>) => {
    if (a.format !== "python" && a.format !== "nodejs") return;
    const ok = confirm(
      `Run ${a.filename}?\n\n` +
        `This will execute the script locally using ${a.format === "python" ? "Python" : "Node.js"}. ` +
        `Make sure you've reviewed the code — it's LLM-generated and will run with your user permissions.\n\n` +
        `Runs have a 5-minute hard timeout. You can kill a run at any time.`
    );
    if (!ok) return;
    setRunOutput([]);
    setRunExitCode(null);
    setRunError(null);
    setRunMissingInterpreter(null);
    setSelectedLogContent(null);
    setSelectedLogPath(null);
    setRunStatus("running");
    setParamFormOpen(false);
    // Reset auto-fix state at the start of each user-initiated run.
    setAutoFixState({
      phase: "idle",
      attempt: 1,
      maxRetries: 0,
      patchPath: null,
      reason: null,
      diagnosis: null,
      previousError: null,
    });
    // Wipe the Smart Run breadcrumb unless the caller has reset/started
    // their own chain (Smart Run sets the trail BEFORE invoking us).
    if (!smartRunMode) setSmartRunTrail([]);
    try {
      const params = paramsOverride ?? paramDraft;
      const result = (await window.flowmind.runAutomation(
        a.filePath,
        a.format as "python" | "nodejs",
        params,
        flowId
      )) as { runId: string };
      setActiveRun({ runId: result.runId, format: a.format as AutomationFormat, kind: "run" });
      // Remember the params so subsequent auto-fix retries (triggered by main)
      // can be reflected back here without the user re-entering values. Main
      // owns the retry; this is just for UI traceability.
      setLastRunParams(params);
    } catch (err) {
      setRunStatus("error");
      setRunError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Compute the combined parameter list for the form: script-detected CLI
   * args are the source of truth for names, augmented with
   * description/observed_values from flow.parameters where names match.
   * A name matches case-insensitively and with dashes/underscores
   * normalised, so "article-subject" / "articleSubject" / "article_subject"
   * all align with a flow parameter named "article_subject".
   */
  /**
   * Memoized parameter list. Was previously a useCallback that we
   * INVOKED multiple times per render (in the conditional, the JSX
   * map, the disabled prop) — each invocation re-ran a regex scan
   * over the script source. With pip's install output also re-rendering
   * 500+ lines on every keystroke, the renderer was spending all its
   * time recomputing instead of accepting input. useMemo caches the
   * VALUE so each render reads it once for free.
   */
  const formParams = useMemo<FlowParameter[]>(() => {
    const format = activeTab;
    if (format !== "python" && format !== "nodejs") return [];
    const scriptContent = automationContent[format];
    if (!scriptContent) return flow?.frontmatter.parameters ?? [];

    const detected = detectCliParamsFromScript(scriptContent);
    if (detected.length === 0) return flow?.frontmatter.parameters ?? [];

    const canon = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
    const byCanonName = new Map<string, FlowParameter>();
    for (const p of flow?.frontmatter.parameters ?? []) {
      byCanonName.set(canon(p.name), p);
    }

    return detected.map((name): FlowParameter => {
      const match = byCanonName.get(canon(name));
      if (match) {
        // Use the script's actual casing so the --flag matches at runtime.
        return { ...match, name };
      }
      return {
        name,
        description: `Runtime value for --${name} (not in extracted parameters metadata; inferred from script).`,
        kind: null,
      };
    });
  }, [activeTab, automationContent, flow]);

  /**
   * Kick off an agent-mode run. Unlike runAutomation this doesn't execute
   * a script — it tells main.ts to spawn the Gemini function-calling loop
   * against the flow. Params are collected up front the same way as for
   * script runs. Synthesis is requested so that after a successful agent
   * run, the trace becomes a replay script in the matching format.
   */
  const startAgentRun = async (a: AutomationFile) => {
    if (a.format !== "python" && a.format !== "nodejs") return;
    const ok = confirm(
      `Run as agent?\n\n` +
        `Gemini will call real tools (filesystem, HTTP, subprocess, Playwright) ` +
        `step-by-step to accomplish this flow. Useful when the pre-generated script ` +
        `doesn't match your local environment. The agent has full user permissions, ` +
        `so only run this on flows you understand.\n\n` +
        `On success, the trace is converted to a ${a.format === "python" ? "Python" : "Node.js"} script ` +
        `and saved as the primary automation for this flow.`
    );
    if (!ok) return;
    // Gate on params — same treatment as the script runner so the agent
    // doesn't have to ask_user for values the flow already knows.
    const params = formParams;
    if (params.length > 0) {
      setParamDraft((prev) => {
        const next = { ...prev };
        for (const p of params) {
          if (!(p.name in next)) next[p.name] = p.observed_values?.[0] ?? "";
        }
        return next;
      });
      setParamFormOpen(true);
      // Stash the intent so "Run with these values" can fire the agent
      // instead of the script runner on that format.
      setPendingAgentFormat(a.format as "python" | "nodejs");
      return;
    }
    kickOffAgentRun(a.format as "python" | "nodejs", {}, 1, false, headedBrowser);
  };

  const kickOffAgentRun = async (
    format: "python" | "nodejs",
    params: Record<string, string>,
    level: 1 | 2 = 1,
    approve = false,
    headed = false
  ) => {
    setAgentSteps([]);
    setAgentPrompt(null);
    setAgentPromptAnswer("");
    try {
      const result = (await window.flowmind.runAsAgent(
        flowId,
        params,
        { synthesize: true, format, level, approveEachStep: approve, headedBrowser: headed }
      )) as { runId: string };
      setAgentRun({ runId: result.runId, format, status: "running" });
      setPendingAgentFormat(null);
      setPendingAgentLevel(1);
      setParamFormOpen(false);
    } catch (err) {
      setAgentRun({
        runId: "",
        format,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /**
   * Stage 3 entry point — "Run with All Tools". Probes the Python
   * desktop helper first; if any pieces are missing, surfaces an
   * install banner AND remembers the user's launch intent so the run
   * resumes automatically once the install succeeds. Otherwise routes
   * through the same agent path with level=2 enabled.
   *
   * `_skipConfirm` is set when this function is called by the auto-
   * resume path after an install — the user already confirmed once
   * and shouldn't have to click through the dialog a second time.
   */
  const startAgentRunWithAllTools = async (a: AutomationFile, _skipConfirm = false) => {
    if (a.format !== "python" && a.format !== "nodejs") return;
    if (!_skipConfirm) {
      const ok = confirm(
        `Run with ALL tools (Stage 3)?\n\n` +
          `Adds desktop UI Automation (window focus, keyboard, mouse, ` +
          `vision-based clicks) on top of the Stage 2 agent. The agent ` +
          `can drive native Windows apps directly — make sure you trust ` +
          `the flow before proceeding.\n\n` +
          `Tip: turn on "Approve each step" if this is your first try ` +
          `with this flow.`
      );
      if (!ok) return;
    }

    // Readiness check — Python + pywinauto + uiautomation + pyautogui +
    // pillow all need to be importable. If anything's missing, surface
    // the install banner AND remember the launch intent so the install-
    // complete handler can resume this run automatically.
    try {
      const status = (await window.flowmind.checkDesktopReady()) as {
        ready: boolean;
        pythonAvailable: boolean;
        missing: string[];
      };
      setDesktopReady(status);
      if (!status.ready) {
        setPendingLevel2Launch(a);
        return;
      }
    } catch (err) {
      setAgentRun({
        runId: "",
        format: a.format as AutomationFormat,
        status: "failed",
        reason: `Desktop readiness probe failed: ${err instanceof Error ? err.message : err}`,
      });
      return;
    }

    const params = formParams;
    if (params.length > 0) {
      setParamDraft((prev) => {
        const next = { ...prev };
        for (const p of params) {
          if (!(p.name in next)) next[p.name] = p.observed_values?.[0] ?? "";
        }
        return next;
      });
      setParamFormOpen(true);
      setPendingAgentFormat(a.format as "python" | "nodejs");
      setPendingAgentLevel(2);
      return;
    }
    kickOffAgentRun(a.format as "python" | "nodejs", {}, 2, approveEachStep, headedBrowser);
  };

  /** Trigger a fresh install of the desktop pip packages. The install
   *  streams output through the existing automation event channel — we
   *  hook activeRun so the user sees the pip output in the run panel,
   *  and the exit handler below re-probes readiness. */
  const installDesktopDeps = async () => {
    setInstallingDesktopDeps(true);
    setRunOutput([]);
    setRunStatus("installing");
    try {
      const result = (await window.flowmind.installDesktopDeps()) as { runId: string };
      setActiveRun({ runId: result.runId, format: "python", kind: "install" });
    } catch (err) {
      setInstallingDesktopDeps(false);
      setRunStatus("error");
      setRunError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Smart Run — single button, auto-escalating execution. Tries the
   * cheapest layer that's available and falls through on failure:
   *   - Script exists → run it (Stage 1 auto-fix kicks in transparently
   *     for any failure). If all patches exhaust → fall through.
   *   - No script, OR script + auto-fix all failed → agent run, which
   *     also synthesizes a script on success so the next Smart Run can
   *     start at the cheap layer again.
   *
   * The escalation logic is in the renderer (this hook + the auto_fix
   * and agent event subscriptions) — no new IPC needed. main.ts treats
   * each layer as an independent run; we just chain them here.
   */
  const startSmartRun = (a: AutomationFile) => {
    if (a.format !== "python" && a.format !== "nodejs") return;
    const ok = confirm(
      `Smart Run ${a.filename}?\n\n` +
        `FlowMind tries the cheapest path that works:\n` +
        `  1. Run the existing script (with auto-fix on failure)\n` +
        `  2. If that's exhausted, run as agent — Gemini drives real tools.\n\n` +
        `On agent success, a fresh script is saved so the next run is cheap again.`
    );
    if (!ok) return;
    const params = formParams;
    if (params.length > 0) {
      setParamDraft((prev) => {
        const next = { ...prev };
        for (const p of params) {
          if (!(p.name in next)) next[p.name] = p.observed_values?.[0] ?? "";
        }
        return next;
      });
      setParamFormOpen(true);
      setPendingSmartRunFormat(a.format as "python" | "nodejs");
      // Make sure the other pending flags don't leak in.
      setPendingAgentFormat(null);
      return;
    }
    kickOffSmartRun(a, {});
  };

  const kickOffSmartRun = (a: AutomationFile, params: Record<string, string>) => {
    setSmartRunMode(true);
    setSmartRunParams(params);
    setSmartRunTrail(["Smart Run started"]);
    setPendingSmartRunFormat(null);
    if (a.filePath && a.format) {
      // Script exists — start at Level 0. Stage 1 auto-fix handles
      // failures transparently. If the entire chain fails, the
      // auto_fix_failed event escalates us to Level 1 below.
      setSmartRunTrail((prev) => [...prev, "Trying existing script…"]);
      runAutomation(a, params);
    } else {
      // No script for this format → skip straight to Level 1.
      setSmartRunTrail((prev) => [...prev, "No script — starting agent…"]);
      kickOffAgentRun(a.format as "python" | "nodejs", params);
    }
  };

  /** Open the parameter entry form (if the script/flow has params) or run straight. */
  const startRun = (a: AutomationFile) => {
    const params = formParams;
    if (params.length > 0) {
      // Seed draft with existing values (so re-running keeps last entry) or
      // the first observed_value as a suggestion.
      setParamDraft((prev) => {
        const next = { ...prev };
        for (const p of params) {
          if (!(p.name in next)) {
            next[p.name] = p.observed_values?.[0] ?? "";
          }
        }
        return next;
      });
      setParamFormOpen(true);
      return;
    }
    // No params — run immediately.
    runAutomation(a, {});
  };

  const killAutomation = async () => {
    if (!activeRun) return;
    try {
      await window.flowmind.killAutomation(activeRun.runId);
    } catch (err) {
      console.error("Kill failed:", err);
    }
  };

  const sendStdin = async () => {
    if (!activeRun || activeRun.kind !== "run") return;
    const text = stdinDraft;
    setStdinDraft("");
    try {
      await window.flowmind.sendInputToAutomation(activeRun.runId, text);
    } catch (err) {
      console.error("Send input failed:", err);
    }
    // Refocus the input so the user can keep typing consecutive answers
    // without having to click back in between.
    stdinInputRef.current?.focus();
  };

  const closeStdin = async () => {
    if (!activeRun || activeRun.kind !== "run") return;
    try {
      await window.flowmind.closeAutomationStdin(activeRun.runId);
    } catch (err) {
      console.error("Close stdin failed:", err);
    }
  };

  const installAutomationDeps = async (a: AutomationFile, deps: string[]) => {
    if (a.format !== "python" && a.format !== "nodejs") return;
    if (deps.length === 0) return;
    const tool = a.format === "python" ? "pip" : "npm";
    const ok = confirm(
      `Install these packages via ${tool}?\n\n${deps.join(" ")}\n\n` +
        `This will modify your ${a.format === "python" ? "Python environment" : "local node_modules"}.`
    );
    if (!ok) return;
    setRunOutput([]);
    setRunExitCode(null);
    setRunError(null);
    setRunMissingInterpreter(null);
    setSelectedLogContent(null);
    setSelectedLogPath(null);
    setRunStatus("installing");
    try {
      const result = (await window.flowmind.installDeps(a.filePath, a.format as "python" | "nodejs", deps)) as { runId: string };
      setActiveRun({ runId: result.runId, format: a.format as AutomationFormat, kind: "install" });
    } catch (err) {
      setRunStatus("error");
      setRunError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteAutomation = async (a: AutomationFile) => {
    if (!confirm(`Delete ${a.filename}? This cannot be undone.`)) return;
    try {
      await window.flowmind.deleteAutomation(a.filePath);
      if (flow) await loadAutomations(flow.frontmatter.name);
      setAutomationContent((prev) => {
        const next = { ...prev };
        delete next[a.format];
        return next;
      });
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

  // Fallback usage strings when we don't have one from a just-generated call.
  // For claude-skill the file is always clean, so this static text IS the usage.
  // For other formats we derive a simple "node/python <path>" from the file path
  // (the backend's richer version with dep detection is preserved if the user
  // just generated the file in this session via usageByFormat).
  const getUsageFor = (format: AutomationFormat): string | null => {
    const fromState = usageByFormat[format];
    if (fromState) return fromState;
    const a = automationsByFormat[format];
    if (!a) return null;
    if (format === "claude-skill") return CLAUDE_SKILL_USAGE;
    if (format === "tutorial") {
      return "**How to use this tutorial**\n\nThis is a plain markdown document. Open it in any markdown viewer or text editor and follow the steps in order.";
    }
    if (format === "python") {
      return `**How to run this script**\n\n\`\`\`bash\npython "${a.filePath}"\n\`\`\``;
    }
    if (format === "nodejs") {
      return `**How to run this script**\n\n\`\`\`bash\nnode "${a.filePath}"\n\`\`\``;
    }
    return null;
  };

  if (!flow) {
    return <div className="empty-state">Loading...</div>;
  }

  const isPartial = flow.frontmatter.type === "partial-flow";
  const isComplete = flow.frontmatter.type === "complete-flow";

  return (
    <>
      <button className="detail-back" onClick={onBack}>
        &larr; Back to Dashboard
      </button>

      <div className="page-header">
        <h1 className="page-title">{flow.frontmatter.name}</h1>
        <span className={`flow-badge ${isComplete ? "complete" : "partial"}`}>
          {isComplete ? "Complete" : "Partial"}
        </span>
      </div>

      <div className="flow-meta" style={{ marginBottom: 16 }}>
        <span>Confidence: {flow.frontmatter.confidence}</span>
        <span>Occurrences: {flow.frontmatter.occurrences}</span>
        {flow.frontmatter.avg_duration && (
          <span>Avg duration: {flow.frontmatter.avg_duration} min</span>
        )}
        <span>
          Last seen:{" "}
          {new Date(flow.frontmatter.last_seen).toLocaleDateString()}
        </span>
      </div>

      <div style={{ marginBottom: 16 }}>
        {flow.frontmatter.apps.map((app) => (
          <span key={app} className="app-tag">
            {app}
          </span>
        ))}
      </div>

      {/* Judge's verdict panel — why this flow was classified the way it was. */}
      <div className={`worth-panel ${flow.frontmatter.worth ?? "unclassified"}`}>
        <div className="worth-title">Judge's verdict</div>
        <div className="worth-verdict">{worthLabel(flow.frontmatter.worth)}</div>
        {flow.frontmatter.worth_reason && (
          <div className="worth-reason">{flow.frontmatter.worth_reason}</div>
        )}
        {!flow.frontmatter.worth_reason && !flow.frontmatter.worth && (
          <div className="worth-reason" style={{ color: "var(--text-muted)" }}>
            This flow predates the classifier. Re-detection with new evidence will score it.
          </div>
        )}
        {(flow.frontmatter.time_saved_estimate_minutes ?? 0) > 0 && (
          <div className="worth-saved">
            ~{flow.frontmatter.time_saved_estimate_minutes} min saved per future occurrence if automated
          </div>
        )}
      </div>

      {/* Parameters detected in this flow — the variables that change from run
          to run. Shown only on complete flows that had parameters extracted. */}
      {isComplete && (flow.frontmatter.parameters?.length ?? 0) > 0 && (
        <div className="interview-section">
          <div className="section-title">Parameters ({flow.frontmatter.parameters!.length})</div>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4, marginBottom: 12 }}>
            Variables the workflow depends on. An automation can hard-code a parameter (Fixed),
            derive it from context (Rule), or ask for it at runtime (Runtime).
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {flow.frontmatter.parameters!.map((param) => {
              const k = paramKindLabel(param.kind);
              return (
                <div
                  key={param.name}
                  style={{
                    padding: 12,
                    background: "var(--surface-hover)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                    <code style={{ fontSize: 13, color: "var(--text)" }}>{param.name}</code>
                    <span
                      style={{
                        fontSize: 11,
                        padding: "2px 8px",
                        borderRadius: 12,
                        background: "transparent",
                        color: k.color,
                        border: `1px solid ${k.color}`,
                        fontWeight: 500,
                      }}
                    >
                      {k.label}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: "var(--text)", marginBottom: 6, lineHeight: 1.5 }}>
                    {param.description}
                  </div>
                  {param.observed_values && param.observed_values.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Examples:</span>
                      {param.observed_values.map((v, i) => (
                        <code
                          key={i}
                          style={{
                            fontSize: 11,
                            padding: "2px 6px",
                            background: "var(--bg-code, rgba(0,0,0,0.2))",
                            border: "1px solid var(--border)",
                            borderRadius: 3,
                          }}
                        >
                          {v}
                        </code>
                      ))}
                    </div>
                  )}
                  {param.kind === "fixed" && param.fixed_value && (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
                      Value: <code>{param.fixed_value}</code>
                    </div>
                  )}
                  {param.kind === "rule" && param.rule && (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
                      Rule: {param.rule}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}


      <div className="detail-body">{flow.body}</div>

      {/* Source descriptions (provenance) */}
      {sources.length > 0 && (
        <div className="interview-section">
          <div
            className="section-title"
            style={{ cursor: "pointer", userSelect: "none" }}
            onClick={toggleSources}
          >
            {sourcesOpen ? "▼" : "▶"} Source Descriptions ({sources.length})
          </div>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
            The phase-1 narratives that contributed to this flow. These are kept permanently
            as provenance for this detection.
          </p>
          {sourcesOpen && (
            <div className="flow-list" style={{ marginTop: 12 }}>
              {sources.map((doc) => {
                const keyScreenshots = keyScreenshotsByFile[doc.filePath] ?? [];
                const start = new Date(doc.frontmatter.windowStart);
                const end = new Date(doc.frontmatter.windowEnd);
                return (
                  <div key={doc.filePath} className="session-card">
                    <div style={{ padding: 12 }}>
                      <div className="flow-card-header">
                        <span className="flow-name">
                          {start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} → {end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                        <span className="flow-badge knowledge">
                          {doc.frontmatter.keyScreenshotCount} key frames
                        </span>
                      </div>
                      <div style={{ marginTop: 8, whiteSpace: "pre-wrap", lineHeight: 1.5, fontSize: 13 }}>
                        {doc.body}
                      </div>
                      {keyScreenshots.length > 0 && (
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                            gap: 8,
                            marginTop: 12,
                          }}
                        >
                          {keyScreenshots.map((p) => (
                            <img
                              key={p}
                              src={encodePath(p)}
                              alt="key frame"
                              style={{
                                width: "100%",
                                borderRadius: 4,
                                border: "1px solid var(--border)",
                              }}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Interview section for partial flows */}
      {isPartial && questions.length > 0 && (
        <div className="interview-section">
          <div className="section-title">Interview — Fill the Gaps</div>
          {questions.map((q) => (
            <div key={q.index} className="interview-question">
              <div className="question-text">{q.question}</div>
              {q.answered ? (
                <div style={{ color: "var(--green)", fontSize: 13 }}>
                  Answered: {q.answer}
                </div>
              ) : (
                <textarea
                  className="answer-input"
                  placeholder="Type your answer..."
                  value={answers[q.index] ?? ""}
                  onChange={(e) =>
                    setAnswers((prev) => ({
                      ...prev,
                      [q.index]: e.target.value,
                    }))
                  }
                />
              )}
            </div>
          ))}
          {questions.some((q) => !q.answered) && (
            <button
              className="btn btn-primary"
              style={{ marginTop: 16 }}
              onClick={submitAllAnswers}
              disabled={
                submitting ||
                !questions
                  .filter((q) => !q.answered)
                  .every((q) => answers[q.index]?.trim())
              }
            >
              {submitting ? "Submitting..." : "Submit All Answers"}
            </button>
          )}
        </div>
      )}

      {/* Automations for complete flows — tabbed */}
      {isComplete && (
        <div className="interview-section">
          <div className="section-title">Generated Automations</div>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>
            One file per format. Files are saved under{" "}
            <code>~/flowtracker/automations/</code>.
          </p>

          {/* Tab headers */}
          <div
            style={{
              display: "flex",
              gap: 4,
              borderBottom: "1px solid var(--border)",
              marginBottom: 12,
            }}
          >
            {FORMAT_TABS.map((tab) => {
              const exists = !!automationsByFormat[tab.key];
              const isActive = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  style={{
                    padding: "8px 14px",
                    background: isActive ? "var(--bg-subtle, rgba(255,255,255,0.05))" : "transparent",
                    border: "none",
                    borderBottom: isActive ? "2px solid var(--accent, #4a9)" : "2px solid transparent",
                    color: isActive ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: isActive ? 600 : 400,
                  }}
                >
                  {tab.label}
                  {exists && <span style={{ marginLeft: 6, color: "var(--accent, #4a9)" }}>●</span>}
                </button>
              );
            })}
          </div>

          {/* Tab content */}
          {(() => {
            const a = automationsByFormat[activeTab];
            const body = automationContent[activeTab];
            const usage = getUsageFor(activeTab);

            if (!a) {
              return (
                <div style={{ padding: 16 }}>
                  <p style={{ color: "var(--text-muted)", marginBottom: 12 }}>
                    No {FORMAT_TABS.find((t) => t.key === activeTab)?.label} automation generated yet.
                  </p>
                  <button
                    className="btn btn-primary"
                    onClick={() => generateAutomation(activeTab, false)}
                    disabled={generating}
                  >
                    {generating ? "Generating..." : `Generate ${FORMAT_TABS.find((t) => t.key === activeTab)?.label}`}
                  </button>
                  {generateError && (
                    <div style={{ marginTop: 12, color: "var(--red, #e55)" }}>
                      Error: {generateError}
                    </div>
                  )}
                </div>
              );
            }

            return (
              <div style={{ padding: 4 }}>
                <div className="flow-meta" style={{ marginBottom: 8 }}>
                  <span><strong>{a.filename}</strong></span>
                  <span>{(a.sizeBytes / 1024).toFixed(1)} KB</span>
                  <span>Generated {new Date(a.createdAt).toLocaleString()}</span>
                </div>

                {/* Install-deps hint — surface when the script imports non-stdlib/non-builtin packages. */}
                {(a.format === "python" || a.format === "nodejs") &&
                 (externalDeps[a.format]?.length ?? 0) > 0 && (
                  <div
                    style={{
                      marginBottom: 12,
                      padding: 10,
                      background: "var(--surface-hover)",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      fontSize: 13,
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      flexWrap: "wrap",
                    }}
                  >
                    <span>
                      <strong>Required packages:</strong>{" "}
                      <code style={{ fontSize: 12 }}>{externalDeps[a.format]!.join(" ")}</code>
                    </span>
                    <button
                      className="btn btn-secondary"
                      style={{ padding: "4px 10px", fontSize: 12, marginLeft: "auto" }}
                      onClick={() => installAutomationDeps(a, externalDeps[a.format]!)}
                      disabled={!!activeRun}
                      title={activeRun ? "Wait for the current run to finish" : `Install via ${a.format === "python" ? "pip" : "npm"}`}
                    >
                      Install with {a.format === "python" ? "pip" : "npm"}
                    </button>
                  </div>
                )}

                {/* "What do these modes do?" — collapsible info panel
                    that lays out the four Run modes side-by-side with
                    their tool lists. Hidden by default to keep the
                    surface uncluttered; the user can open it on demand. */}
                {(a.format === "python" || a.format === "nodejs") && (
                  <div style={{ marginBottom: 8 }}>
                    <button
                      className="btn btn-secondary"
                      style={{ padding: "2px 10px", fontSize: 12 }}
                      onClick={() => setRunModesInfoOpen((v) => !v)}
                      title="What does each Run button do?"
                    >
                      {runModesInfoOpen ? "▼" : "▶"} What do these modes do?
                    </button>
                    {runModesInfoOpen && (
                      <div
                        style={{
                          marginTop: 6,
                          padding: 12,
                          border: "1px solid var(--border)",
                          borderRadius: 4,
                          background: "var(--surface-hover)",
                          fontSize: 12,
                          display: "grid",
                          gridTemplateColumns: "auto 1fr",
                          gap: "8px 16px",
                        }}
                      >
                        <strong>Run Script</strong>
                        <span>
                          Executes the pre-generated <code>.{a.format === "python" ? "py" : "js"}</code> file as-is.
                          No LLM at runtime — fastest, cheapest. If it
                          exits non-zero, ScriptDoctor patches it and
                          retries automatically (up to 3 times).
                        </span>

                        <strong>Smart Run</strong>
                        <span>
                          Tries Run Script first; if all auto-fix retries
                          fail, escalates to the agent (Level 1) and
                          synthesizes a fresh script on success. Daily-use
                          default — picks the cheapest path that works.
                        </span>

                        <strong>Run as Agent</strong>
                        <span>
                          Gemini drives real tools live: <em>files, HTTP,
                          subprocesses, headless chromium, ask_user.</em>
                          Does NOT touch your real mouse, keyboard, or
                          windows — safe to keep using the computer
                          while it runs. On success, the trace is saved
                          as a replay script so the next run can use
                          Run Script.
                        </span>

                        <strong>Run with All Tools</strong>
                        <span>
                          Adds the desktop layer on top of Run as Agent:
                          <em> native window focus, real mouse/keyboard,
                          control_click via UI Automation, vision-based
                          coordinate clicks.</em> Drives your visible
                          desktop — the agent will compete with you for
                          mouse and keyboard, so don't use the computer
                          while it runs. Requires Python + a few pip
                          packages (the install banner walks you through it).
                        </span>
                      </div>
                    )}
                  </div>
                )}

                <div className="btn-group" style={{ marginBottom: 12 }}>
                  {(a.format === "python" || a.format === "nodejs") && (
                    activeRun && activeRun.format === a.format ? (
                      <button className="btn btn-danger" onClick={killAutomation}>
                        {activeRun.kind === "install" ? "Kill Install" : "Kill Run"}
                      </button>
                    ) : (
                      <>
                        <button
                          className="btn btn-primary"
                          onClick={() => startSmartRun(a)}
                          disabled={!!activeRun || agentRun !== null}
                          title="Smart Run: tries the script first (with auto-fix), escalates to agent on exhaustion. Cheapest path that works."
                        >
                          Smart Run
                        </button>
                        <button
                          className="btn btn-secondary"
                          onClick={() => startRun(a)}
                          disabled={!!activeRun || agentRun !== null}
                          title={activeRun ? "Another automation is currently running" : `Execute this ${a.format === "python" ? "Python" : "Node.js"} script directly (no agent escalation)`}
                        >
                          Run Script
                        </button>
                        <button
                          className="btn btn-secondary"
                          onClick={() => startAgentRun(a)}
                          disabled={!!activeRun || agentRun !== null}
                          title="Skip the script and run the agent directly. Gemini calls real tools step-by-step. After success, a fresh script is saved as the new primary."
                        >
                          Run as Agent
                        </button>
                        <button
                          className="btn btn-secondary"
                          onClick={() => startAgentRunWithAllTools(a)}
                          disabled={!!activeRun || agentRun !== null}
                          title="Stage 3: agent + desktop UI Automation + vision. Can drive native Windows apps. Requires Python with pywinauto/uiautomation/pyautogui/pillow."
                        >
                          Run with All Tools
                        </button>
                      </>
                    )
                  )}
                  <button className="btn btn-secondary" onClick={() => openAutomation(a)}>Open</button>
                  <button className="btn btn-secondary" onClick={() => revealAutomation(a)}>Reveal in Explorer</button>
                  <button className="btn btn-secondary" onClick={() => copyAutomation(activeTab)}>Copy</button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => generateAutomation(activeTab, true)}
                    disabled={generating}
                  >
                    {generating ? "Regenerating..." : "Regenerate"}
                  </button>
                  <button className="btn btn-danger" onClick={() => deleteAutomation(a)}>Delete</button>
                </div>

                {/* Parameter entry form — appears after clicking Run when the script declares CLI args (detected directly from the script) or the flow has parameters metadata. Collects values upfront so the script runs non-interactively. */}
                {paramFormOpen && formParams.length > 0 && (
                  <div
                    style={{
                      marginBottom: 12,
                      padding: 14,
                      border: "1px solid var(--accent)",
                      borderRadius: 4,
                      background: "var(--surface-hover)",
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
                      Run with these parameters
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14 }}>
                      Fill in the values. The script will run with each parameter passed as a CLI flag (e.g. <code>--subject Octopus</code>) and as a FLOWMIND_PARAM_* env var.
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                      {formParams.map((param, idx) => (
                        <div key={param.name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <label style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "baseline", gap: 8 }}>
                            <span>{humanizeParamName(param.name)}</span>
                            <code style={{ fontSize: 11, fontWeight: 400, color: "var(--text-muted)" }}>
                              --{param.name}
                            </code>
                          </label>
                          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                            {param.description}
                          </div>
                          <input
                            ref={idx === 0 ? firstParamInputRef : undefined}
                            type="text"
                            value={paramDraft[param.name] ?? ""}
                            onChange={(e) =>
                              setParamDraft((prev) => ({ ...prev, [param.name]: e.target.value }))
                            }
                            placeholder={param.observed_values?.[0] ?? `Enter ${param.name}...`}
                            style={{
                              padding: "6px 10px",
                              background: "var(--bg-code, rgba(0,0,0,0.25))",
                              border: "1px solid var(--border)",
                              borderRadius: 3,
                              color: "var(--text)",
                              fontFamily: "inherit",
                              fontSize: 13,
                            }}
                          />
                          {param.observed_values && param.observed_values.length > 1 && (
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Previous:</span>
                              {param.observed_values.slice(0, 4).map((v) => (
                                <button
                                  key={v}
                                  onClick={() =>
                                    setParamDraft((prev) => ({ ...prev, [param.name]: v }))
                                  }
                                  style={{
                                    fontSize: 11,
                                    padding: "2px 6px",
                                    background: "var(--bg-code, rgba(0,0,0,0.2))",
                                    border: "1px solid var(--border)",
                                    borderRadius: 3,
                                    cursor: "pointer",
                                    color: "var(--text-muted)",
                                    fontFamily: "inherit",
                                  }}
                                >
                                  {v}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                      <button
                        className="btn btn-primary"
                        onClick={() => {
                          // Routing priority: Smart Run > Agent > plain
                          // script. Whichever pending flag is set decides
                          // which orchestrator the form's submit fires.
                          if (pendingSmartRunFormat) {
                            kickOffSmartRun(a, paramDraft);
                          } else if (pendingAgentFormat) {
                            kickOffAgentRun(
                              pendingAgentFormat,
                              paramDraft,
                              pendingAgentLevel,
                              pendingAgentLevel === 2 ? approveEachStep : false,
                              headedBrowser
                            );
                          } else {
                            runAutomation(a, paramDraft);
                          }
                        }}
                        disabled={
                          !!activeRun ||
                          !(formParams.every(
                            (p) => (paramDraft[p.name] ?? "").trim().length > 0
                          ))
                        }
                      >
                        {pendingSmartRunFormat
                          ? "Smart Run with these values"
                          : pendingAgentFormat && pendingAgentLevel === 2
                          ? "Run with All Tools, these values"
                          : pendingAgentFormat
                          ? "Run as Agent with these values"
                          : "Run with these values"}
                      </button>
                      <button
                        className="btn btn-secondary"
                        onClick={() => {
                          setParamFormOpen(false);
                          setPendingAgentFormat(null);
                          setPendingAgentLevel(1);
                          setPendingSmartRunFormat(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {/* Stage 3 readiness banner — surfaced after the user
                    clicks "Run with All Tools" if Python or any of the
                    pip packages aren't ready. Stays visible until the
                    user clicks Install (which streams pip output into
                    the run panel) and the post-install probe clears it. */}
                {desktopReady && !desktopReady.ready && (activeTab === "python" || activeTab === "nodejs") && (
                  <div
                    style={{
                      marginBottom: 8,
                      padding: "10px 12px",
                      border: "1px solid var(--border)",
                      borderLeft: "3px solid var(--yellow, #fbbf24)",
                      borderRadius: 4,
                      background: "rgba(251, 191, 36, 0.06)",
                      fontSize: 13,
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <div>
                      <strong>Desktop tools not ready.</strong>{" "}
                      {!desktopReady.pythonAvailable ? (
                        <>
                          Python isn't installed or not on PATH. Install it from{" "}
                          <a
                            href="https://www.python.org/downloads/"
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: "var(--accent)" }}
                          >
                            python.org/downloads
                          </a>
                          , then click Re-check.
                        </>
                      ) : (
                        <>
                          Missing pip packages: <code>{desktopReady.missing.join(" ")}</code>
                        </>
                      )}
                    </div>
                    {pendingLevel2Launch && (
                      <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                        Your <strong>Run with All Tools</strong> request will resume automatically once the install finishes.
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 6 }}>
                      {desktopReady.pythonAvailable && desktopReady.missing.length > 0 && (
                        <button
                          className="btn btn-primary"
                          style={{ padding: "4px 12px", fontSize: 12 }}
                          onClick={installDesktopDeps}
                          disabled={installingDesktopDeps || !!activeRun}
                        >
                          {installingDesktopDeps ? "Installing…" : `Install via pip`}
                        </button>
                      )}
                      <button
                        className="btn btn-secondary"
                        style={{ padding: "4px 12px", fontSize: 12 }}
                        onClick={async () => {
                          const s = (await window.flowmind.checkDesktopReady()) as {
                            ready: boolean;
                            pythonAvailable: boolean;
                            missing: string[];
                          };
                          setDesktopReady(s);
                        }}
                      >
                        Re-check
                      </button>
                      <button
                        className="btn btn-secondary"
                        style={{ padding: "4px 12px", fontSize: 12 }}
                        onClick={() => {
                          setDesktopReady(null);
                          setPendingLevel2Launch(null);
                        }}
                      >
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}

                {/* Approve-each-step toggle — visible when the param
                    form is open AND the user is about to start a Level 2
                    run. Lets them gate every destructive desktop call
                    behind a yes/no prompt for first-time runs. */}
                {paramFormOpen && pendingAgentLevel === 2 && (
                  <div
                    style={{
                      marginBottom: 8,
                      padding: "8px 12px",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      fontSize: 13,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <input
                      type="checkbox"
                      id="approve-each-step"
                      checked={approveEachStep}
                      onChange={(e) => setApproveEachStep(e.target.checked)}
                    />
                    <label htmlFor="approve-each-step" style={{ cursor: "pointer" }}>
                      Approve every destructive step before it executes
                      <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>
                        (clicks, types, key sends, app launches, focus changes)
                      </span>
                    </label>
                  </div>
                )}

                {/* Show-browser toggle — visible whenever an agent run
                    is queued (Level 1 or 2). Off = headless chromium
                    (default; agent is invisible). On = headed chromium
                    (a real browser window opens so the user can watch
                    the agent navigate). Only relevant if the agent
                    actually uses browser_* tools — otherwise this is a
                    no-op. */}
                {paramFormOpen && pendingAgentFormat && (
                  <div
                    style={{
                      marginBottom: 8,
                      padding: "8px 12px",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      fontSize: 13,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <input
                      type="checkbox"
                      id="headed-browser"
                      checked={headedBrowser}
                      onChange={(e) => setHeadedBrowser(e.target.checked)}
                    />
                    <label htmlFor="headed-browser" style={{ cursor: "pointer" }}>
                      Show browser window
                      <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>
                        (only if the agent actually opens chromium — useful for watching/debugging)
                      </span>
                    </label>
                  </div>
                )}

                {/* Smart Run breadcrumb — shows the escalation trail
                    (Script → Auto-fix → Agent) at a glance. Visible
                    whenever Smart Run was used this round; cleared on
                    the next Run / Run Script / Run as Agent click. */}
                {smartRunTrail.length > 0 && (activeTab === "python" || activeTab === "nodejs") && (
                  <div
                    style={{
                      marginBottom: 8,
                      padding: "8px 12px",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      background: "rgba(52, 211, 153, 0.05)",
                      fontSize: 12,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <strong style={{ color: "var(--green, #2ecc71)" }}>Smart Run:</strong>
                    {smartRunTrail.map((step, i) => (
                      <span key={i} style={{ color: "var(--text-muted)" }}>
                        {i > 0 && <span style={{ marginRight: 6 }}>→</span>}
                        {step}
                      </span>
                    ))}
                  </div>
                )}

                {/* Run output panel — appears once a run has started, persists after exit. */}
                {(runStatus !== "idle" && (activeTab === "python" || activeTab === "nodejs")) && (
                  <div
                    style={{
                      marginBottom: 12,
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        padding: "8px 12px",
                        background: "var(--surface-hover)",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        fontSize: 13,
                      }}
                    >
                      <span>
                        <strong>
                          {/* Auto-fix phase overrides the plain run status so
                              the user sees "Diagnosing..." instead of the
                              misleading "✗ Exited" between retries. */}
                          {autoFixState.phase === "diagnosing" && (
                            <>● Auto-fixing (attempt {autoFixState.attempt}/{autoFixState.maxRetries + 1})…</>
                          )}
                          {autoFixState.phase === "retrying" && runStatus === "running" && (
                            <>● Running retry {autoFixState.attempt}/{autoFixState.maxRetries + 1}…</>
                          )}
                          {autoFixState.phase === "exhausted" && (
                            <>⚠ Auto-fix exhausted</>
                          )}
                          {autoFixState.phase === "disabled" && runStatus !== "running" && (
                            <>✗ Exited (auto-fix disabled)</>
                          )}
                          {/* Fall through to the plain statuses when no
                              auto-fix override is active. */}
                          {(autoFixState.phase === "idle" ||
                            (autoFixState.phase === "retrying" && runStatus !== "running") ||
                            (autoFixState.phase === "disabled" && runStatus === "running")) && (
                            <>
                              {runStatus === "running" && "● Running..."}
                              {runStatus === "installing" && "● Installing packages..."}
                              {runStatus === "completed" && (runExitCode === 0
                                ? (activeRun?.kind === "install" ? "✓ Install complete" : "✓ Completed")
                                : "✗ Exited")}
                              {runStatus === "killed" && "⊗ Killed"}
                              {runStatus === "timeout" && "⊘ Timed out"}
                              {runStatus === "error" && "⚠ Failed to start"}
                            </>
                          )}
                        </strong>
                        {runExitCode !== null && runStatus !== "running" && autoFixState.phase !== "diagnosing" && (
                          <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>
                            exit code {runExitCode}
                          </span>
                        )}
                      </span>
                      <div style={{ display: "flex", gap: 6 }}>
                        {/* Stop auto-fixing — visible during diagnosis or
                            while a retry is running, disabled afterwards. */}
                        {(autoFixState.phase === "diagnosing" || autoFixState.phase === "retrying") && activeRun && (
                          <button
                            className="btn btn-secondary"
                            style={{ padding: "2px 10px", fontSize: 12 }}
                            onClick={async () => {
                              if (!activeRun) return;
                              try {
                                await window.flowmind.disableAutoFix(activeRun.runId);
                                setAutoFixState((p) => ({ ...p, phase: "disabled" }));
                              } catch (err) {
                                console.error("disableAutoFix failed:", err);
                              }
                            }}
                            title="Stop auto-fixing this chain. The current run finishes, but no further patches are tried."
                          >
                            Stop auto-fix
                          </button>
                        )}
                        {/* Promote patch — appears after a retry succeeded
                            (exit 0) while the active script was a patch. */}
                        {autoFixState.patchPath &&
                          runStatus === "completed" &&
                          runExitCode === 0 &&
                          autoFixState.phase === "retrying" && (
                            <button
                              className="btn btn-primary"
                              style={{ padding: "2px 10px", fontSize: 12 }}
                              onClick={async () => {
                                if (!autoFixState.patchPath) return;
                                const ok = confirm(
                                  "Promote this patched script to the primary file?\n\n" +
                                    "The original script will be overwritten with the patched contents. The patch file will be deleted."
                                );
                                if (!ok) return;
                                try {
                                  await window.flowmind.promotePatch(autoFixState.patchPath);
                                  if (flow?.frontmatter.name) {
                                    await loadAutomations(flow.frontmatter.name);
                                  }
                                  setAutoFixState((p) => ({ ...p, patchPath: null }));
                                } catch (err) {
                                  alert(`Promote failed: ${err instanceof Error ? err.message : err}`);
                                }
                              }}
                              title="Overwrite the primary script with the working patch."
                            >
                              Promote patch
                            </button>
                          )}
                        <button
                          className="btn btn-secondary"
                          style={{ padding: "2px 10px", fontSize: 12 }}
                          onClick={() => {
                            setRunStatus("idle");
                            setRunOutput([]);
                            setRunExitCode(null);
                            setRunError(null);
                            setRunMissingInterpreter(null);
                            setAutoFixState({
                              phase: "idle",
                              attempt: 1,
                              maxRetries: 0,
                              patchPath: null,
                              reason: null,
                              diagnosis: null,
                              previousError: null,
                            });
                          }}
                          disabled={runStatus === "running" || autoFixState.phase === "diagnosing"}
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                    {runError && (
                      <div style={{ padding: 12, color: "var(--red, #e55)", fontSize: 13 }}>
                        {runError}
                      </div>
                    )}
                    {/* Auto-fix diagnosis card — shown after the doctor has
                        returned a patch. Renders even after the retry
                        completes so the user can still read what was
                        changed. Clears on the next user-initiated run. */}
                    {autoFixState.diagnosis && (
                      <div
                        style={{
                          padding: 12,
                          background: "rgba(129, 140, 248, 0.08)",
                          borderTop: "1px solid var(--border)",
                          borderBottom: "1px solid var(--border)",
                          fontSize: 13,
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                        }}
                      >
                        <div>
                          <strong>Auto-fix diagnosis</strong>{" "}
                          <span style={{ color: "var(--text-muted)" }}>
                            (attempt {autoFixState.attempt}/{autoFixState.maxRetries + 1})
                          </span>
                        </div>
                        {autoFixState.previousError && (
                          <div style={{ color: "var(--text-muted)" }}>
                            <strong>Prior error:</strong> {autoFixState.previousError}
                          </div>
                        )}
                        <div>
                          <strong>Fix:</strong> {autoFixState.diagnosis}
                        </div>
                        {autoFixState.patchPath && (
                          <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                            Patch: <code>{autoFixState.patchPath}</code>
                          </div>
                        )}
                      </div>
                    )}
                    {runMissingInterpreter && (
                      <div
                        style={{
                          padding: 12,
                          background: "rgba(251, 191, 36, 0.08)",
                          borderTop: "1px solid var(--border)",
                          borderBottom: "1px solid var(--border)",
                          fontSize: 13,
                        }}
                      >
                        <strong>
                          {runMissingInterpreter === "python" ? "Python" : "Node.js"} is not installed on this machine.
                        </strong>{" "}
                        Install it, then try Run again. Download from{" "}
                        <a
                          href={INTERPRETER_DOWNLOADS[runMissingInterpreter].url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "var(--accent)" }}
                        >
                          {INTERPRETER_DOWNLOADS[runMissingInterpreter].label}
                        </a>
                        .
                      </div>
                    )}
                    <pre
                      style={{
                        margin: 0,
                        padding: 12,
                        background: "var(--bg-code, rgba(0,0,0,0.25))",
                        fontSize: 12,
                        maxHeight: 400,
                        overflow: "auto",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {runOutput.length === 0 && runStatus === "running" && (
                        <span style={{ color: "var(--text-muted)" }}>Waiting for output...</span>
                      )}
                      {runOutput.map((chunk, i) => (
                        <span
                          key={i}
                          style={{
                            color: chunk.stream === "stderr" ? "var(--red, #e55)" : "inherit",
                          }}
                        >
                          {chunk.data}
                        </span>
                      ))}
                    </pre>

                    {/* Stdin input field — only for live script runs, not installs or finished runs. */}
                    {runStatus === "running" && activeRun?.kind === "run" && (
                      <div
                        style={{
                          display: "flex",
                          gap: 6,
                          padding: 8,
                          borderTop: "1px solid var(--border)",
                          background: "var(--surface-hover)",
                        }}
                      >
                        <span style={{ color: "var(--text-muted)", fontFamily: "monospace", fontSize: 12, lineHeight: "28px" }}>&gt;</span>
                        <input
                          ref={stdinInputRef}
                          type="text"
                          value={stdinDraft}
                          onChange={(e) => setStdinDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              sendStdin();
                            }
                          }}
                          placeholder="Type input for the script and press Enter..."
                          style={{
                            flex: 1,
                            padding: "4px 8px",
                            background: "var(--bg-code, rgba(0,0,0,0.25))",
                            border: "1px solid var(--border)",
                            borderRadius: 3,
                            color: "var(--text)",
                            fontFamily: "monospace",
                            fontSize: 12,
                          }}
                        />
                        <button
                          className="btn btn-secondary"
                          style={{ padding: "4px 10px", fontSize: 12 }}
                          onClick={sendStdin}
                          title="Send line to script stdin"
                        >
                          Send
                        </button>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: "4px 10px", fontSize: 12 }}
                          onClick={closeStdin}
                          title="Close stdin (Ctrl-D equivalent) — for scripts that read until EOF"
                        >
                          EOF
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Agent live trace panel (Stage 2). Replaces the plain
                    run-output panel when an agent run is active/finished,
                    showing each tool call as it happens and the final
                    outcome. Kept visible until the user dismisses it or
                    starts a new run. */}
                {agentRun && agentRun.format === activeTab && (
                  <div
                    style={{
                      marginBottom: 12,
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        padding: "8px 12px",
                        background: "var(--surface-hover)",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        fontSize: 13,
                      }}
                    >
                      <strong>
                        {agentRun.status === "running" && "● Agent running..."}
                        {agentRun.status === "synthesizing" && "● Synthesizing replay script..."}
                        {agentRun.status === "saved" && "✓ Agent finished — script saved"}
                        {agentRun.status === "success" && "✓ Agent finished"}
                        {agentRun.status === "failed" && "⚠ Agent failed"}
                      </strong>
                      <button
                        className="btn btn-secondary"
                        style={{ padding: "2px 10px", fontSize: 12 }}
                        onClick={() => {
                          setAgentRun(null);
                          setAgentSteps([]);
                          setAgentPrompt(null);
                        }}
                        disabled={agentRun.status === "running" || agentRun.status === "synthesizing"}
                      >
                        Clear
                      </button>
                    </div>
                    {agentRun.reason && agentRun.status === "failed" && (
                      <div style={{ padding: 12, color: "var(--red, #e55)", fontSize: 13 }}>
                        {agentRun.reason}
                      </div>
                    )}
                    {agentRun.synthesizedPath && (
                      <div style={{ padding: 10, fontSize: 12, color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}>
                        Replay script saved to <code>{agentRun.synthesizedPath}</code>
                      </div>
                    )}
                    <div
                      style={{
                        maxHeight: 420,
                        overflow: "auto",
                        fontFamily: "monospace",
                        fontSize: 12,
                      }}
                    >
                      {agentSteps.length === 0 && agentRun.status === "running" && (
                        <div style={{ padding: 12, color: "var(--text-muted)" }}>
                          Waiting for the first tool call...
                        </div>
                      )}
                      {agentSteps.map((s) => (
                        <div
                          key={s.index}
                          style={{
                            padding: "8px 12px",
                            borderBottom: "1px solid var(--border)",
                            background: s.error ? "rgba(229, 85, 85, 0.06)" : "transparent",
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                            <span>
                              <span style={{ color: "var(--text-muted)" }}>#{s.index}</span>{" "}
                              <strong style={{ color: "var(--accent)" }}>{s.name}</strong>
                              {s.durationMs != null && (
                                <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>
                                  {s.durationMs < 1000 ? `${s.durationMs} ms` : `${(s.durationMs / 1000).toFixed(1)} s`}
                                </span>
                              )}
                            </span>
                            {!s.result && !s.error && (
                              <span style={{ color: "var(--text-muted)", fontSize: 11 }}>running…</span>
                            )}
                          </div>
                          <pre
                            style={{
                              margin: "4px 0 0",
                              padding: 0,
                              fontSize: 11,
                              color: "var(--text-muted)",
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                            }}
                          >
                            args: {JSON.stringify(s.args)}
                          </pre>
                          {s.result && (
                            <pre
                              style={{
                                margin: "4px 0 0",
                                padding: 0,
                                fontSize: 11,
                                color: s.error ? "var(--red, #e55)" : "var(--text)",
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                              }}
                            >
                              {s.error ? `error: ${s.error}` : `→ ${truncateForDisplay(JSON.stringify(s.result))}`}
                            </pre>
                          )}
                        </div>
                      ))}
                      {agentRun.finalText && (
                        <div
                          style={{
                            padding: "10px 12px",
                            fontSize: 13,
                            fontFamily: "var(--font-sans, system-ui)",
                            background: "rgba(129, 140, 248, 0.05)",
                          }}
                        >
                          <strong>Agent summary:</strong> {agentRun.finalText}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Agent ask_user prompt — modal-ish panel that blocks
                    further steps until the user answers. */}
                {agentPrompt && (
                  <div
                    style={{
                      marginBottom: 12,
                      padding: 12,
                      border: "1px solid var(--accent)",
                      borderRadius: 4,
                      background: "rgba(129, 140, 248, 0.08)",
                      fontSize: 13,
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>
                      The agent is asking:
                    </div>
                    <div style={{ marginBottom: 10 }}>{agentPrompt.prompt}</div>
                    {agentPrompt.kind === "text" && (
                      <div style={{ display: "flex", gap: 6 }}>
                        <input
                          type="text"
                          value={agentPromptAnswer}
                          onChange={(e) => setAgentPromptAnswer(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              window.flowmind.answerAgentPrompt(agentPrompt.promptId, agentPromptAnswer);
                              setAgentPrompt(null);
                            }
                          }}
                          autoFocus
                          style={{
                            flex: 1,
                            padding: "6px 8px",
                            background: "var(--bg-code, rgba(0,0,0,0.25))",
                            border: "1px solid var(--border)",
                            borderRadius: 3,
                            color: "var(--text)",
                            fontFamily: "monospace",
                            fontSize: 12,
                          }}
                        />
                        <button
                          className="btn btn-primary"
                          style={{ padding: "4px 10px", fontSize: 12 }}
                          onClick={() => {
                            window.flowmind.answerAgentPrompt(agentPrompt.promptId, agentPromptAnswer);
                            setAgentPrompt(null);
                          }}
                          disabled={agentPromptAnswer.trim().length === 0}
                        >
                          Send
                        </button>
                      </div>
                    )}
                    {agentPrompt.kind === "yesno" && (
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          className="btn btn-primary"
                          style={{ padding: "4px 14px", fontSize: 12 }}
                          onClick={() => {
                            window.flowmind.answerAgentPrompt(agentPrompt.promptId, "yes");
                            setAgentPrompt(null);
                          }}
                        >
                          Yes
                        </button>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: "4px 14px", fontSize: 12 }}
                          onClick={() => {
                            window.flowmind.answerAgentPrompt(agentPrompt.promptId, "no");
                            setAgentPrompt(null);
                          }}
                        >
                          No
                        </button>
                      </div>
                    )}
                    {agentPrompt.kind === "choice" && agentPrompt.choices && (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {agentPrompt.choices.map((c) => (
                          <button
                            key={c}
                            className="btn btn-secondary"
                            style={{ padding: "4px 12px", fontSize: 12 }}
                            onClick={() => {
                              window.flowmind.answerAgentPrompt(agentPrompt.promptId, c);
                              setAgentPrompt(null);
                            }}
                          >
                            {c}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Previous runs — persistent log history. Shown for python/nodejs only. */}
                {(activeTab === "python" || activeTab === "nodejs") && (runLogs[activeTab]?.length ?? 0) > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div className="section-title" style={{ fontSize: 13, marginTop: 8 }}>
                      Previous runs ({runLogs[activeTab]?.length ?? 0})
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                      {(runLogs[activeTab] ?? []).map((entry) => {
                        const isSelected = entry.filePath === selectedLogPath;
                        const statusColor = entry.reason === "completed" && entry.exitCode === 0
                          ? "var(--green)"
                          : entry.reason === "completed"
                          ? "var(--yellow)"
                          : "var(--red, #e55)";
                        const statusText = entry.reason === null
                          ? "unclosed"
                          : entry.reason === "completed"
                          ? (entry.exitCode === 0 ? "ok" : `exit ${entry.exitCode}`)
                          : entry.reason;
                        return (
                          <div
                            key={entry.filePath}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              padding: "6px 10px",
                              background: isSelected ? "var(--surface-hover)" : "transparent",
                              border: "1px solid var(--border)",
                              borderRadius: 4,
                              fontSize: 12,
                            }}
                          >
                            <span style={{ color: statusColor, minWidth: 70 }}>{statusText}</span>
                            <span style={{ flex: 1, color: "var(--text-muted)" }}>
                              {new Date(entry.startedAt).toLocaleString()}
                            </span>
                            {entry.durationMs != null && (
                              <span style={{ color: "var(--text-muted)" }}>
                                {entry.durationMs < 1000
                                  ? `${entry.durationMs} ms`
                                  : `${(entry.durationMs / 1000).toFixed(1)} s`}
                              </span>
                            )}
                            <span style={{ color: "var(--text-muted)" }}>{(entry.sizeBytes / 1024).toFixed(1)} KB</span>
                            <button
                              className="btn btn-secondary"
                              style={{ padding: "2px 8px", fontSize: 11 }}
                              onClick={() => viewLog(entry)}
                            >
                              {isSelected ? "Viewing" : "View"}
                            </button>
                            <button
                              className="btn btn-secondary"
                              style={{ padding: "2px 8px", fontSize: 11 }}
                              onClick={() => deleteLog(entry)}
                            >
                              Delete
                            </button>
                          </div>
                        );
                      })}
                    </div>

                    {selectedLogContent !== null && (
                      <div
                        style={{
                          marginTop: 8,
                          border: "1px solid var(--border)",
                          borderRadius: 4,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            padding: "6px 10px",
                            background: "var(--surface-hover)",
                            display: "flex",
                            justifyContent: "space-between",
                            fontSize: 12,
                          }}
                        >
                          <span>{selectedLogPath?.split(/[\\/]/).pop()}</span>
                          <button
                            className="btn btn-secondary"
                            style={{ padding: "2px 10px", fontSize: 11 }}
                            onClick={() => {
                              setSelectedLogContent(null);
                              setSelectedLogPath(null);
                            }}
                          >
                            Close
                          </button>
                        </div>
                        <pre
                          style={{
                            margin: 0,
                            padding: 12,
                            background: "var(--bg-code, rgba(0,0,0,0.25))",
                            fontSize: 12,
                            maxHeight: 400,
                            overflow: "auto",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                          {selectedLogContent}
                        </pre>
                      </div>
                    )}
                  </div>
                )}

                {generateError && (
                  <div style={{ marginBottom: 12, color: "var(--red, #e55)" }}>
                    Error: {generateError}
                  </div>
                )}

                {usage && (
                  <div
                    style={{
                      marginBottom: 12,
                      padding: 12,
                      background: "var(--bg-subtle, rgba(0,255,0,0.05))",
                      border: "1px solid var(--border)",
                      borderRadius: 4,
                      fontSize: 13,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {usage}
                  </div>
                )}

                <pre
                  style={{
                    margin: 0,
                    padding: 12,
                    background: "var(--bg-code, rgba(0,0,0,0.2))",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    fontSize: 12,
                    maxHeight: 500,
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {body ?? "Loading..."}
                </pre>
              </div>
            );
          })()}
        </div>
      )}
    </>
  );
}
