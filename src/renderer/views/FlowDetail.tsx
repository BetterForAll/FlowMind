import { useState, useEffect, useCallback, useRef } from "react";
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
          }
          return null; // run is done
        }
        return current;
      });
    });
    return unsubscribe;
  }, [flow, automationsByFormat, reloadLogsForFormat, reloadExternalDeps]);

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

  const runAutomation = async (a: AutomationFile) => {
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
    try {
      const result = (await window.flowmind.runAutomation(a.filePath, a.format as "python" | "nodejs")) as { runId: string };
      setActiveRun({ runId: result.runId, format: a.format as AutomationFormat, kind: "run" });
    } catch (err) {
      setRunStatus("error");
      setRunError(err instanceof Error ? err.message : String(err));
    }
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

                <div className="btn-group" style={{ marginBottom: 12 }}>
                  {(a.format === "python" || a.format === "nodejs") && (
                    activeRun && activeRun.format === a.format ? (
                      <button className="btn btn-danger" onClick={killAutomation}>
                        {activeRun.kind === "install" ? "Kill Install" : "Kill Run"}
                      </button>
                    ) : (
                      <button
                        className="btn btn-primary"
                        onClick={() => runAutomation(a)}
                        disabled={!!activeRun}
                        title={activeRun ? "Another automation is currently running" : `Execute this ${a.format === "python" ? "Python" : "Node.js"} script`}
                      >
                        Run Automation
                      </button>
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
                          {runStatus === "running" && "● Running..."}
                          {runStatus === "installing" && "● Installing packages..."}
                          {runStatus === "completed" && (runExitCode === 0
                            ? (activeRun?.kind === "install" ? "✓ Install complete" : "✓ Completed")
                            : "✗ Exited")}
                          {runStatus === "killed" && "⊗ Killed"}
                          {runStatus === "timeout" && "⊘ Timed out"}
                          {runStatus === "error" && "⚠ Failed to start"}
                        </strong>
                        {runExitCode !== null && runStatus !== "running" && (
                          <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>
                            exit code {runExitCode}
                          </span>
                        )}
                      </span>
                      <button
                        className="btn btn-secondary"
                        style={{ padding: "2px 10px", fontSize: 12 }}
                        onClick={() => {
                          setRunStatus("idle");
                          setRunOutput([]);
                          setRunExitCode(null);
                          setRunError(null);
                          setRunMissingInterpreter(null);
                        }}
                        disabled={runStatus === "running"}
                      >
                        Clear
                      </button>
                    </div>
                    {runError && (
                      <div style={{ padding: 12, color: "var(--red, #e55)", fontSize: 13 }}>
                        {runError}
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
