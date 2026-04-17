import { contextBridge, ipcRenderer } from "electron";

const api = {
  // Flows
  getAllFlows: () => ipcRenderer.invoke("flows:getAll"),
  getFlowById: (id: string) => ipcRenderer.invoke("flows:getById", id),
  getAllKnowledge: () => ipcRenderer.invoke("knowledge:getAll"),

  // Descriptions (phase-1 artifacts)
  getAllDescriptions: () => ipcRenderer.invoke("descriptions:getAll"),
  getDescriptionsByWindowStarts: (windowStarts: string[]) =>
    ipcRenderer.invoke("descriptions:getByWindowStarts", windowStarts),
  getDescriptionKeyScreenshots: (descriptionFilePath: string) =>
    ipcRenderer.invoke("descriptions:getKeyScreenshots", descriptionFilePath),

  // Detection
  runDetection: () => ipcRenderer.invoke("detection:runNow"),
  getDetectionStatus: () => ipcRenderer.invoke("detection:getStatus"),

  // Capture
  startCapture: () => ipcRenderer.invoke("capture:start"),
  stopCapture: () => ipcRenderer.invoke("capture:stop"),
  getCaptureStats: () => ipcRenderer.invoke("capture:getStats"),
  toggleAudio: (enabled: boolean) => ipcRenderer.invoke("capture:toggleAudio", enabled),

  // Raw data management
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  getSessionScreenshots: (sessionPath: string) => ipcRenderer.invoke("sessions:getScreenshots", sessionPath),
  getSessionAudioFiles: (sessionPath: string) => ipcRenderer.invoke("sessions:getAudioFiles", sessionPath),
  getAudioDataUrl: (filePath: string) => ipcRenderer.invoke("sessions:getAudioDataUrl", filePath),
  deleteSession: (sessionPath: string) => ipcRenderer.invoke("sessions:delete", sessionPath),
  deleteAnalyzedSessions: () => ipcRenderer.invoke("sessions:deleteAnalyzed"),
  getTotalStorageSize: () => ipcRenderer.invoke("sessions:getTotalSize"),

  // Interview
  getQuestions: (flowId: string) =>
    ipcRenderer.invoke("interview:getQuestions", flowId),
  submitAllAnswers: (flowId: string, answers: Record<number, string>) =>
    ipcRenderer.invoke("interview:submitAllAnswers", flowId, answers),
  generateAutomation: (flowId: string, format: string) =>
    ipcRenderer.invoke("interview:generateAutomation", flowId, format),

  // Automations
  listAutomationsForFlow: (flowName: string) =>
    ipcRenderer.invoke("automations:listForFlow", flowName),
  readAutomation: (filePath: string) =>
    ipcRenderer.invoke("automations:readFile", filePath),
  openAutomation: (filePath: string) =>
    ipcRenderer.invoke("automations:open", filePath),
  revealAutomation: (filePath: string) =>
    ipcRenderer.invoke("automations:revealInExplorer", filePath),
  deleteAutomation: (filePath: string) =>
    ipcRenderer.invoke("automations:delete", filePath),
  runAutomation: (
    filePath: string,
    format: "python" | "nodejs",
    params?: Record<string, string>,
    flowId?: string
  ) => ipcRenderer.invoke("automations:run", filePath, format, params, flowId),
  disableAutoFix: (runId: string) =>
    ipcRenderer.invoke("automations:disableAutoFix", runId),
  promotePatch: (patchPath: string) =>
    ipcRenderer.invoke("automations:promotePatch", patchPath),
  killAutomation: (runId: string) =>
    ipcRenderer.invoke("automations:kill", runId),
  sendInputToAutomation: (runId: string, text: string) =>
    ipcRenderer.invoke("automations:sendInput", runId, text),
  closeAutomationStdin: (runId: string) =>
    ipcRenderer.invoke("automations:closeStdin", runId),
  listRunLogs: (flowName: string, format: string) =>
    ipcRenderer.invoke("automations:listRunLogs", flowName, format),
  readRunLog: (filePath: string) =>
    ipcRenderer.invoke("automations:readRunLog", filePath),
  deleteRunLog: (filePath: string) =>
    ipcRenderer.invoke("automations:deleteRunLog", filePath),
  getExternalDeps: (filePath: string, format: "python" | "nodejs") =>
    ipcRenderer.invoke("automations:getExternalDeps", filePath, format),
  installDeps: (filePath: string, format: "python" | "nodejs", packages: string[]) =>
    ipcRenderer.invoke("automations:installDeps", filePath, format, packages),

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
  onAutomationEvent: (callback: (event: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, runEvent: unknown) =>
      callback(runEvent);
    ipcRenderer.on("automations:event", listener);
    return () => {
      ipcRenderer.removeListener("automations:event", listener);
    };
  },
  onAutoFixEvent: (callback: (event: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, fixEvent: unknown) =>
      callback(fixEvent);
    ipcRenderer.on("automations:autoFixEvent", listener);
    return () => {
      ipcRenderer.removeListener("automations:autoFixEvent", listener);
    };
  },

  // Audio capture (renderer-side)
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
  sendAudioChunk: (buffer: ArrayBuffer) => {
    ipcRenderer.send("audio:chunk", Buffer.from(buffer));
  },
};

export type FlowMindAPI = typeof api;

contextBridge.exposeInMainWorld("flowmind", api);
