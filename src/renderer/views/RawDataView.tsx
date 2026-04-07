import { useState, useEffect, useCallback } from "react";
import type { SessionInfo } from "../../capture/storage";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "in progress";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  if (min > 0) return `${min}m ${sec % 60}s`;
  return `${sec}s`;
}

export function RawDataView() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [totalSize, setTotalSize] = useState(0);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [screenshots, setScreenshots] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [sessionList, size] = await Promise.all([
        window.flowmind.listSessions(),
        window.flowmind.getTotalStorageSize(),
      ]);
      setSessions(sessionList as SessionInfo[]);
      setTotalSize(size as number);
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const toggleSession = async (session: SessionInfo) => {
    if (expandedSession === session.id) {
      setExpandedSession(null);
      setScreenshots([]);
      return;
    }
    setExpandedSession(session.id);
    const paths = await window.flowmind.getSessionScreenshots(session.path) as string[];
    setScreenshots(paths);
  };

  const deleteSession = async (session: SessionInfo) => {
    await window.flowmind.deleteSession(session.path);
    await loadData();
    if (expandedSession === session.id) {
      setExpandedSession(null);
      setScreenshots([]);
    }
  };

  const deleteAllAnalyzed = async () => {
    const count = await window.flowmind.deleteAnalyzedSessions() as number;
    if (count > 0) {
      await loadData();
    }
  };

  const analyzedCount = sessions.filter((s) => s.analyzed).length;
  const analyzedSize = sessions
    .filter((s) => s.analyzed)
    .reduce((sum, s) => sum + s.sizeBytes, 0);

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Raw Data</h1>
        {analyzedCount > 0 && (
          <button className="btn btn-secondary" onClick={deleteAllAnalyzed}>
            Delete {analyzedCount} Analyzed ({formatBytes(analyzedSize)})
          </button>
        )}
      </div>

      <div className="card-grid">
        <div className="stat-card">
          <div className="stat-label">Total Storage</div>
          <div className="stat-value">{formatBytes(totalSize)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Sessions</div>
          <div className="stat-value">{sessions.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Analyzed</div>
          <div className="stat-value">{analyzedCount} / {sessions.length}</div>
        </div>
      </div>

      {loading ? (
        <div className="empty-state"><p>Loading...</p></div>
      ) : sessions.length === 0 ? (
        <div className="empty-state">
          <h3>No captured data</h3>
          <p>Start capture from the Dashboard to begin recording.</p>
        </div>
      ) : (
        <div className="flow-list">
          {sessions.map((session) => (
            <div key={session.id} className="session-card">
              <div
                className="flow-card"
                onClick={() => toggleSession(session)}
              >
                <div className="flow-card-header">
                  <span className="flow-name">{session.date} / {session.id}</span>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    {session.analyzed && (
                      <span className="flow-badge complete">Analyzed</span>
                    )}
                    <span className="flow-badge knowledge">{formatBytes(session.sizeBytes)}</span>
                  </div>
                </div>
                <div className="flow-meta">
                  <span>{formatDuration(session.startedAt, session.endedAt)}</span>
                  <span>{session.eventCount} events</span>
                  <span>{session.screenshotCount} screenshots</span>
                  <span>{new Date(session.startedAt).toLocaleTimeString()}</span>
                </div>
              </div>

              {expandedSession === session.id && (
                <div className="session-expanded">
                  <div className="session-actions">
                    <button
                      className="btn btn-danger"
                      onClick={(e) => { e.stopPropagation(); deleteSession(session); }}
                    >
                      Delete Session
                    </button>
                  </div>
                  {screenshots.length > 0 ? (
                    <div className="screenshot-grid">
                      {screenshots.map((ssPath) => (
                        <div key={ssPath} className="screenshot-thumb">
                          <img
                            src={`flowmind://file/${encodeURIComponent(ssPath.replace(/\\/g, "/"))}`}
                            alt="screenshot"
                            loading="lazy"
                          />
                          <div className="screenshot-time">
                            {new Date(parseInt(ssPath.match(/(\d+)\.jpg/)?.[1] ?? "0")).toLocaleTimeString()}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="empty-state" style={{ padding: 16 }}>No screenshots in this session.</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
