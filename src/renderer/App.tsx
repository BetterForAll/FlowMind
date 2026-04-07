import { useState, useEffect, useCallback } from "react";
import { Dashboard } from "./views/Dashboard";
import { FlowDetail } from "./views/FlowDetail";
import { KnowledgeView } from "./views/KnowledgeView";
import type { FlowDocument, KnowledgeDocument, CaptureStats } from "../types";

type View = "dashboard" | "flow-detail" | "knowledge";

export function App() {
  const [view, setView] = useState<View>("dashboard");
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null);
  const [detectionStatus, setDetectionStatus] = useState<string>("idle");
  const [completeFlows, setCompleteFlows] = useState<FlowDocument[]>([]);
  const [partialFlows, setPartialFlows] = useState<FlowDocument[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeDocument[]>([]);
  const [captureStats, setCaptureStats] = useState<CaptureStats | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [flows, knowledgeItems, stats] = await Promise.all([
        window.flowmind.getAllFlows(),
        window.flowmind.getAllKnowledge(),
        window.flowmind.getCaptureStats(),
      ]);
      setCompleteFlows(flows.complete);
      setPartialFlows(flows.partial);
      setKnowledge(knowledgeItems);
      setCaptureStats(stats as CaptureStats);
    } catch {
      // May fail on first load
    }
  }, []);

  useEffect(() => {
    loadData();

    const unsub1 = window.flowmind.onDetectionStatus(setDetectionStatus);
    const unsub2 = window.flowmind.onDetectionResults(() => loadData());
    const unsub3 = window.flowmind.onCaptureStats((stats) => {
      setCaptureStats(stats as CaptureStats);
    });
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [loadData]);

  const openFlow = (id: string) => {
    setSelectedFlowId(id);
    setView("flow-detail");
  };

  const goBack = () => {
    setSelectedFlowId(null);
    setView("dashboard");
  };

  const startCapture = async () => {
    await window.flowmind.startCapture();
  };

  const stopCapture = async () => {
    await window.flowmind.stopCapture();
    setCaptureStats(await window.flowmind.getCaptureStats() as CaptureStats);
  };

  const runDetection = async () => {
    await window.flowmind.runDetection();
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-brand">FlowMind</div>
        <nav className="sidebar-nav">
          <button
            className={`nav-item ${view === "dashboard" ? "active" : ""}`}
            onClick={() => { setView("dashboard"); setSelectedFlowId(null); }}
          >
            Dashboard
          </button>
          <button
            className={`nav-item ${view === "knowledge" ? "active" : ""}`}
            onClick={() => setView("knowledge")}
          >
            Knowledge
          </button>
        </nav>
        <div className="sidebar-status">
          <span className={`status-dot ${captureStats?.capturing ? "capturing" : detectionStatus}`} />
          {captureStats?.capturing
            ? "Capturing..."
            : detectionStatus === "running"
              ? "Detecting..."
              : detectionStatus === "error"
                ? "Error"
                : "Idle"}
        </div>
      </aside>

      <main className="main">
        {view === "dashboard" && (
          <Dashboard
            completeFlows={completeFlows}
            partialFlows={partialFlows}
            knowledgeCount={knowledge.length}
            captureStats={captureStats}
            onOpenFlow={openFlow}
            onRunDetection={runDetection}
            onStartCapture={startCapture}
            onStopCapture={stopCapture}
            detectionStatus={detectionStatus}
          />
        )}
        {view === "flow-detail" && selectedFlowId && (
          <FlowDetail
            flowId={selectedFlowId}
            onBack={goBack}
            onDataChanged={loadData}
          />
        )}
        {view === "knowledge" && (
          <KnowledgeView knowledge={knowledge} />
        )}
      </main>
    </div>
  );
}
