import type { KnowledgeDocument } from "../../types";

interface KnowledgeViewProps {
  knowledge: KnowledgeDocument[];
}

const categoryLabels: Record<string, string> = {
  "decision-pattern": "Decision Pattern",
  habit: "Habit",
  preference: "Preference",
  "tool-usage": "Tool Usage",
};

export function KnowledgeView({ knowledge }: KnowledgeViewProps) {
  if (knowledge.length === 0) {
    return (
      <>
        <div className="page-header">
          <h1 className="page-title">Knowledge</h1>
        </div>
        <div className="empty-state">
          <h3>No knowledge fragments yet</h3>
          <p>
            FlowMind will capture behavioral observations and decision patterns
            as it analyzes your screen activity.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Knowledge</h1>
      </div>
      <div className="flow-list">
        {knowledge.map((k) => (
          <div key={k.frontmatter.id} className="flow-card">
            <div className="flow-card-header">
              <span className="flow-name">
                {k.body.split("\n").find((l) => l.startsWith("# "))?.replace("# ", "") ??
                  k.frontmatter.id}
              </span>
              <span className="flow-badge knowledge">
                {categoryLabels[k.frontmatter.category] ?? k.frontmatter.category}
              </span>
            </div>
            <div className="flow-meta">
              <span>
                Detected{" "}
                {new Date(k.frontmatter.detected).toLocaleDateString()}
              </span>
            </div>
            <div style={{ marginTop: 8 }}>
              {k.frontmatter.apps.map((app) => (
                <span key={app} className="app-tag">
                  {app}
                </span>
              ))}
            </div>
            <div
              style={{
                marginTop: 12,
                fontSize: 13,
                color: "var(--text-muted)",
                whiteSpace: "pre-wrap",
              }}
            >
              {extractSection(k.body, "Observation")}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function extractSection(body: string, heading: string): string {
  const lines = body.split("\n");
  let capturing = false;
  const result: string[] = [];

  for (const line of lines) {
    if (line.startsWith(`## ${heading}`)) {
      capturing = true;
      continue;
    }
    if (capturing && line.startsWith("##")) break;
    if (capturing) result.push(line);
  }

  return result.join("\n").trim();
}
