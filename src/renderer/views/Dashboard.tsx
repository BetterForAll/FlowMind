import type { FlowDocument, CaptureStats } from "../../types";

interface DashboardProps {
  completeFlows: FlowDocument[];
  partialFlows: FlowDocument[];
  knowledgeCount: number;
  captureStats: CaptureStats | null;
  onOpenFlow: (id: string) => void;
  onRunDetection: () => void;
  onStartCapture: () => void;
  onStopCapture: () => void;
  detectionStatus: string;
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  if (hr > 0) return `${hr}h ${min % 60}m`;
  if (min > 0) return `${min}m ${sec % 60}s`;
  return `${sec}s`;
}

export function Dashboard({
  completeFlows,
  partialFlows,
  knowledgeCount,
  captureStats,
  onOpenFlow,
  onRunDetection,
  onStartCapture,
  onStopCapture,
  detectionStatus,
}: DashboardProps) {
  const isCapturing = captureStats?.capturing ?? false;

  const allFlows = [
    ...completeFlows.map((f) => ({ ...f, kind: "complete" as const })),
    ...partialFlows.map((f) => ({ ...f, kind: "partial" as const })),
  ].sort(
    (a, b) =>
      new Date(b.frontmatter.last_seen).getTime() -
      new Date(a.frontmatter.last_seen).getTime()
  );

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Dashboard</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className={`btn ${isCapturing ? "btn-danger" : "btn-primary"}`}
            onClick={isCapturing ? onStopCapture : onStartCapture}
          >
            {isCapturing ? "Stop Capture" : "Start Capture"}
          </button>
          <button
            className="btn btn-secondary"
            onClick={onRunDetection}
            disabled={detectionStatus === "running"}
          >
            {detectionStatus === "running" ? "Detecting..." : "Run Detection"}
          </button>
        </div>
      </div>

      {/* Capture stats */}
      {isCapturing && captureStats && (
        <div className="capture-stats">
          <div className="capture-stats-row">
            <span className="status-dot running" />
            <span>Capturing — {formatDuration(captureStats.sessionDuration)}</span>
          </div>
          <div className="capture-stats-row">
            <span>Events: {captureStats.eventCount}</span>
            <span>Screenshots: {captureStats.screenshotCount}</span>
            <span>Audio: {captureStats.audioEnabled ? "ON" : "OFF"}</span>
          </div>
        </div>
      )}

      <div className="card-grid">
        <div className="stat-card">
          <div className="stat-label">Complete Flows</div>
          <div className="stat-value">{completeFlows.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Partial Flows</div>
          <div className="stat-value">{partialFlows.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Knowledge Fragments</div>
          <div className="stat-value">{knowledgeCount}</div>
        </div>
      </div>

      {allFlows.length === 0 ? (
        <div className="empty-state">
          <h3>No flows detected yet</h3>
          <p>
            Click "Start Capture" to begin recording your activity, then
            "Run Detection" to analyze it with AI.
          </p>
        </div>
      ) : (
        <>
          <div className="section-title">Recent Flows</div>
          <div className="flow-list">
            {allFlows.map((flow) => (
              <div
                key={flow.frontmatter.id}
                className="flow-card"
                onClick={() => onOpenFlow(flow.frontmatter.id)}
              >
                <div className="flow-card-header">
                  <span className="flow-name">{flow.frontmatter.name}</span>
                  <span className={`flow-badge ${flow.kind}`}>
                    {flow.kind === "complete" ? "Complete" : "Partial"}
                  </span>
                </div>
                <div className="flow-meta">
                  <span>
                    {flow.frontmatter.occurrences} occurrence
                    {flow.frontmatter.occurrences !== 1 ? "s" : ""}
                  </span>
                  <span>
                    Last seen{" "}
                    {new Date(flow.frontmatter.last_seen).toLocaleDateString()}
                  </span>
                </div>
                <div style={{ marginTop: 8 }}>
                  {flow.frontmatter.apps.map((app) => (
                    <span key={app} className="app-tag">
                      {app}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
