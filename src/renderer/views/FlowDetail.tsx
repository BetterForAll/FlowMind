import { useState, useEffect, useCallback } from "react";
import type { FlowDocument, InterviewQuestion, AutomationFile } from "../../types";
import type { DescriptionDocument } from "../../engine/description-store";

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

                <div className="btn-group" style={{ marginBottom: 12 }}>
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
