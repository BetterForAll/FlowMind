import { contextBridge, ipcRenderer } from "electron";

const api = {
  // Flows
  getAllFlows: () => ipcRenderer.invoke("flows:getAll"),
  getFlowById: (id: string) => ipcRenderer.invoke("flows:getById", id),
  getAllKnowledge: () => ipcRenderer.invoke("knowledge:getAll"),

  // Detection
  runDetection: () => ipcRenderer.invoke("detection:runNow"),
  getDetectionStatus: () => ipcRenderer.invoke("detection:getStatus"),

  // Capture
  startCapture: () => ipcRenderer.invoke("capture:start"),
  stopCapture: () => ipcRenderer.invoke("capture:stop"),
  getCaptureStats: () => ipcRenderer.invoke("capture:getStats"),
  toggleAudio: (enabled: boolean) => ipcRenderer.invoke("capture:toggleAudio", enabled),
  setAudioAutoMode: (enabled: boolean) => ipcRenderer.invoke("capture:setAudioAutoMode", enabled),

  // Raw data management
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  getSessionScreenshots: (sessionPath: string) => ipcRenderer.invoke("sessions:getScreenshots", sessionPath),
  deleteSession: (sessionPath: string) => ipcRenderer.invoke("sessions:delete", sessionPath),
  deleteAnalyzedSessions: () => ipcRenderer.invoke("sessions:deleteAnalyzed"),
  getTotalStorageSize: () => ipcRenderer.invoke("sessions:getTotalSize"),

  // Interview
  getQuestions: (flowId: string) =>
    ipcRenderer.invoke("interview:getQuestions", flowId),
  submitAnswer: (flowId: string, questionIndex: number, answer: string) =>
    ipcRenderer.invoke("interview:submitAnswer", flowId, questionIndex, answer),
  generateAutomation: (flowId: string, format: string) =>
    ipcRenderer.invoke("interview:generateAutomation", flowId, format),

  // Settings
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (updates: Record<string, unknown>) => ipcRenderer.invoke("settings:update", updates),

  // Events from main process
  onDetectionStatus: (callback: (status: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: string) =>
      callback(status);
    ipcRenderer.on("detection:status", listener);
    return () => ipcRenderer.removeListener("detection:status", listener);
  },
  onDetectionResults: (callback: (results: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, results: unknown) =>
      callback(results);
    ipcRenderer.on("detection:results", listener);
    return () => ipcRenderer.removeListener("detection:results", listener);
  },
  onDetectionError: (callback: (message: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) =>
      callback(message);
    ipcRenderer.on("detection:error", listener);
    return () => ipcRenderer.removeListener("detection:error", listener);
  },
  onCaptureStats: (callback: (stats: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, stats: unknown) =>
      callback(stats);
    ipcRenderer.on("capture:stats", listener);
    return () => ipcRenderer.removeListener("capture:stats", listener);
  },

  // Audio capture (renderer-side)
  onAudioStartMonitoring: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("audio:startMonitoring", listener);
    return () => ipcRenderer.removeListener("audio:startMonitoring", listener);
  },
  onAudioStopMonitoring: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("audio:stopMonitoring", listener);
    return () => ipcRenderer.removeListener("audio:stopMonitoring", listener);
  },
  onAudioStartRecording: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("audio:startRecording", listener);
    return () => ipcRenderer.removeListener("audio:startRecording", listener);
  },
  onAudioStopRecording: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("audio:stopRecording", listener);
    return () => ipcRenderer.removeListener("audio:stopRecording", listener);
  },
  sendMicLevel: (level: number) => {
    ipcRenderer.send("audio:micLevel", level);
  },
  sendAudioChunk: (buffer: ArrayBuffer) => {
    ipcRenderer.send("audio:chunk", Buffer.from(buffer));
  },
};

export type FlowMindAPI = typeof api;

contextBridge.exposeInMainWorld("flowmind", api);
