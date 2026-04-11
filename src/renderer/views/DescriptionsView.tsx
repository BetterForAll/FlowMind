import { useState, useEffect, useCallback } from "react";
import type { DescriptionDocument } from "../../engine/description-store";

function formatWindow(start: string, end: string): string {
  try {
    const s = new Date(start);
    const e = new Date(end);
    const date = s.toLocaleDateString();
    const startTime = s.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const endTime = e.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `${date}  ${startTime} → ${endTime}`;
  } catch {
    return `${start} → ${end}`;
  }
}

function encodePath(p: string): string {
  return `flowmind://file/${encodeURIComponent(p.replace(/\\/g, "/"))}`;
}

export function DescriptionsView() {
  const [descriptions, setDescriptions] = useState<DescriptionDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [keyScreenshotsByFile, setKeyScreenshotsByFile] = useState<Record<string, string[]>>({});
  const [filter, setFilter] = useState<"all" | "linked" | "unlinked">("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const docs = await window.flowmind.getAllDescriptions() as DescriptionDocument[];
      // Show newest first for browsing
      docs.sort(
        (a, b) =>
          new Date(b.frontmatter.windowStart).getTime() -
          new Date(a.frontmatter.windowStart).getTime()
      );
      setDescriptions(docs);
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const unsub = window.flowmind.onDetectionResults(() => load());
    return () => { unsub(); };
  }, [load]);

  const toggle = async (doc: DescriptionDocument) => {
    const isCurrentlyOpen = expanded.has(doc.filePath);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(doc.filePath)) next.delete(doc.filePath);
      else next.add(doc.filePath);
      return next;
    });

    if (!isCurrentlyOpen && doc.frontmatter.keyScreenshotCount > 0 && !keyScreenshotsByFile[doc.filePath]) {
      const paths = await window.flowmind.getDescriptionKeyScreenshots(doc.filePath) as string[];
      setKeyScreenshotsByFile((prev) => ({ ...prev, [doc.filePath]: paths }));
    }
  };

  const visible = descriptions.filter((d) => {
    if (filter === "linked") return d.frontmatter.linked;
    if (filter === "unlinked") return !d.frontmatter.linked;
    return true;
  });

  const linkedCount = descriptions.filter((d) => d.frontmatter.linked).length;
  const analyzedCount = descriptions.filter((d) => d.frontmatter.analyzed).length;

  return (
    <div className="view">
      <div className="view-header">
        <h1>Descriptions</h1>
        <p className="view-subtitle">
          Phase-1 narratives produced from captured sessions. Each describes ~1 minute of activity.
        </p>
      </div>

      <div className="card-grid">
        <div className="stat-card">
          <div className="stat-label">Total</div>
          <div className="stat-value">{descriptions.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Analyzed</div>
          <div className="stat-value">{analyzedCount}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Linked to flows</div>
          <div className="stat-value">{linkedCount}</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, margin: "16px 0" }}>
        <button
          className={`btn ${filter === "all" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setFilter("all")}
        >
          All ({descriptions.length})
        </button>
        <button
          className={`btn ${filter === "linked" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setFilter("linked")}
        >
          Linked ({linkedCount})
        </button>
        <button
          className={`btn ${filter === "unlinked" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setFilter("unlinked")}
        >
          Unlinked ({descriptions.length - linkedCount})
        </button>
      </div>

      {loading ? (
        <div className="empty-state"><p>Loading...</p></div>
      ) : visible.length === 0 ? (
        <div className="empty-state">
          <h3>No descriptions yet</h3>
          <p>Start capture — phase-1 will generate a description every minute.</p>
        </div>
      ) : (
        <div className="flow-list">
          {visible.map((doc) => {
            const isOpen = expanded.has(doc.filePath);
            const keyScreenshots = keyScreenshotsByFile[doc.filePath] ?? [];
            return (
              <div key={doc.filePath} className="session-card">
                <div className="flow-card" onClick={() => toggle(doc)}>
                  <div className="flow-card-header">
                    <span className="flow-name">
                      {formatWindow(doc.frontmatter.windowStart, doc.frontmatter.windowEnd)}
                    </span>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {doc.frontmatter.linked && (
                        <span className="flow-badge complete">Linked</span>
                      )}
                      {doc.frontmatter.analyzed && (
                        <span className="flow-badge">Analyzed</span>
                      )}
                      {doc.frontmatter.keyScreenshotCount > 0 && (
                        <span className="flow-badge knowledge">
                          {doc.frontmatter.keyScreenshotCount} key frames
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flow-meta">
                    <span>{doc.frontmatter.eventCount} events</span>
                    <span>{doc.frontmatter.screenshotCount} screenshots</span>
                    <span title={doc.frontmatter.sessionId}>
                      session: {doc.frontmatter.sessionId.slice(-8)}
                    </span>
                  </div>
                </div>

                {isOpen && (
                  <div className="session-expanded" style={{ padding: 16 }}>
                    <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
                      {doc.body}
                    </div>

                    {keyScreenshots.length > 0 && (
                      <>
                        <div className="section-title" style={{ marginTop: 16 }}>
                          Key Visual Frames
                        </div>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                            gap: 8,
                            marginTop: 8,
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
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
