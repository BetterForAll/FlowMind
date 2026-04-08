import { useState, useEffect } from "react";
import type { FlowDocument, InterviewQuestion } from "../../types";

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
  const [generatedContent, setGeneratedContent] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const f = await window.flowmind.getFlowById(flowId);
      setFlow(f);
      if (f?.frontmatter.type === "partial-flow") {
        const qs = await window.flowmind.getQuestions(flowId);
        setQuestions(qs);
      }
    })();
  }, [flowId]);

  const submitAnswer = async (index: number) => {
    const answer = answers[index];
    if (!answer?.trim()) return;

    setSubmitting(true);
    try {
      const result = await window.flowmind.submitAnswer(flowId, index, answer);
      if (result.promoted) {
        onDataChanged();
        onBack();
      } else {
        setQuestions((prev) =>
          prev.map((q) =>
            q.index === index ? { ...q, answered: true, answer } : q
          )
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const generateAutomation = async (format: string) => {
    setGenerating(true);
    setGeneratedContent(null);
    setGenerateError(null);
    try {
      const result = await window.flowmind.generateAutomation(flowId, format);
      setGeneratedContent(result.content);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setGenerateError(message);
      console.error("[FlowMind] Automation generation failed:", err);
    } finally {
      setGenerating(false);
    }
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
                <>
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
                  <button
                    className="btn btn-primary"
                    style={{ marginTop: 8 }}
                    onClick={() => submitAnswer(q.index)}
                    disabled={submitting || !answers[q.index]?.trim()}
                  >
                    {submitting ? "Submitting..." : "Submit Answer"}
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Automation generation for complete flows */}
      {isComplete && (
        <div className="interview-section">
          <div className="section-title">Generate Automation</div>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>
            Convert this flow into an executable automation or documentation.
          </p>
          <div className="btn-group">
            <button
              className="btn btn-secondary"
              onClick={() => generateAutomation("python")}
              disabled={generating}
            >
              Python Script
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => generateAutomation("nodejs")}
              disabled={generating}
            >
              Node.js Script
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => generateAutomation("claude-skill")}
              disabled={generating}
            >
              Claude Skill
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => generateAutomation("tutorial")}
              disabled={generating}
            >
              Tutorial
            </button>
          </div>
          {generating && (
            <div style={{ marginTop: 16, color: "var(--text-muted)" }}>
              Generating...
            </div>
          )}
          {generateError && (
            <div style={{ marginTop: 16, color: "var(--red, #e55)" }}>
              Error: {generateError}
            </div>
          )}
          {generatedContent && (
            <div className="detail-body" style={{ marginTop: 16 }}>
              {generatedContent}
            </div>
          )}
        </div>
      )}
    </>
  );
}
