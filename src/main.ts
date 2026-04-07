import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, protocol, net } from "electron";
import path from "node:path";
import dotenv from "dotenv";

// Load .env from project root (not cwd, which changes in Electron Forge)
dotenv.config({ path: path.join(app.getAppPath(), ".env") });
import { FlowDetectionEngine } from "./engine/flow-detection";
import { FlowStore } from "./engine/flow-store";
import { InterviewEngine } from "./engine/interview";
import { CaptureOrchestrator } from "./capture/orchestrator";
import { CaptureStorage } from "./capture/storage";
import { loadConfig, saveConfig, cleanupModeToMs, type AppConfig } from "./config";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let flowEngine: FlowDetectionEngine;
let flowStore: FlowStore;
let interviewEngine: InterviewEngine;
let captureOrchestrator: CaptureOrchestrator;
let detectionInterval: ReturnType<typeof setInterval> | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    title: "FlowMind",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)
    );
  }

  mainWindow.on("close", (e) => {
    if (tray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Give capture orchestrator a reference to the window (for audio IPC)
  captureOrchestrator.setWindow(mainWindow);
}

function updateTrayMenu(): void {
  if (!tray) return;
  const isCapturing = captureOrchestrator.isCapturing();

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open FlowMind",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: "separator" },
    {
      label: isCapturing ? "Stop Capture" : "Start Capture",
      click: async () => {
        if (isCapturing) {
          await captureOrchestrator.stop();
          runDetection();
        } else {
          await captureOrchestrator.start();
        }
        updateTrayMenu();
        mainWindow?.webContents.send("capture:stats", captureOrchestrator.getStats());
      },
    },
    {
      label: "Run Detection Now",
      click: () => runDetection(),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        tray = null;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip(isCapturing ? "FlowMind — Capturing" : "FlowMind — Idle");
}

function createTray(): void {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

  updateTrayMenu();

  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

async function runDetection(): Promise<void> {
  try {
    mainWindow?.webContents.send("detection:status", "running");
    const results = await flowEngine.detectFlows();
    mainWindow?.webContents.send("detection:status", "idle");
    mainWindow?.webContents.send("detection:results", results);

    // Run cleanup after successful detection
    await runCleanup();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Detection failed:", message);
    mainWindow?.webContents.send("detection:status", "error");
    mainWindow?.webContents.send("detection:error", message);
  }
}

async function runCleanup(): Promise<void> {
  try {
    const config = await loadConfig();
    const maxAgeMs = cleanupModeToMs(config.cleanupMode);
    const deleted = await CaptureStorage.cleanupAnalyzed(maxAgeMs);
    if (deleted > 0) {
      console.log(`Cleanup: deleted ${deleted} analyzed sessions (mode: ${config.cleanupMode})`);
    }
  } catch (err) {
    console.error("Cleanup failed:", err);
  }
}

function setupIPC(): void {
  // Flows
  ipcMain.handle("flows:getAll", async () => {
    return flowStore.getAllFlows();
  });

  ipcMain.handle("flows:getById", async (_e, id: string) => {
    return flowStore.getFlowById(id);
  });

  ipcMain.handle("knowledge:getAll", async () => {
    return flowStore.getAllKnowledge();
  });

  // Detection controls
  ipcMain.handle("detection:runNow", async () => {
    await runDetection();
  });

  ipcMain.handle("detection:getStatus", () => {
    return { running: flowEngine.isRunning() };
  });

  // Capture controls
  ipcMain.handle("capture:start", async () => {
    await captureOrchestrator.start();
    updateTrayMenu();
  });

  ipcMain.handle("capture:stop", async () => {
    await captureOrchestrator.stop();
    updateTrayMenu();
    // Auto-run detection after capture stops
    runDetection();
  });

  ipcMain.handle("capture:getStats", () => {
    return captureOrchestrator.getStats();
  });

  ipcMain.handle("capture:toggleAudio", (_e, enabled: boolean) => {
    captureOrchestrator.toggleAudio(enabled);
  });

  ipcMain.handle("capture:setAudioAutoMode", (_e, enabled: boolean) => {
    captureOrchestrator.setAudioAutoMode(enabled);
  });

  // Audio chunks from renderer
  ipcMain.on("audio:chunk", async (_e, buffer: Buffer) => {
    await captureOrchestrator.handleAudioChunk(buffer);
  });

  // Raw data management
  ipcMain.handle("sessions:list", async () => {
    return CaptureStorage.listAllSessions();
  });

  ipcMain.handle("sessions:getScreenshots", async (_e, sessionPath: string) => {
    return CaptureStorage.getSessionScreenshots(sessionPath);
  });

  ipcMain.handle("sessions:delete", async (_e, sessionPath: string) => {
    await CaptureStorage.deleteSession(sessionPath);
  });

  ipcMain.handle("sessions:deleteAnalyzed", async () => {
    return CaptureStorage.cleanupAnalyzed(0);
  });

  ipcMain.handle("sessions:getTotalSize", async () => {
    return CaptureStorage.getTotalSize();
  });

  // Interview
  ipcMain.handle("interview:getQuestions", async (_e, flowId: string) => {
    return interviewEngine.getQuestions(flowId);
  });

  ipcMain.handle(
    "interview:submitAnswer",
    async (_e, flowId: string, questionIndex: number, answer: string) => {
      return interviewEngine.submitAnswer(flowId, questionIndex, answer);
    }
  );

  ipcMain.handle("interview:generateAutomation", async (_e, flowId: string, format: string) => {
    return interviewEngine.generateAutomation(flowId, format);
  });

  // Settings
  ipcMain.handle("settings:get", async () => {
    return loadConfig();
  });

  ipcMain.handle("settings:update", async (_e, updates: Partial<AppConfig>) => {
    return saveConfig(updates);
  });
}

// Register custom protocol to serve local files (screenshots)
protocol.registerSchemesAsPrivileged([
  { scheme: "flowmind", privileges: { bypassCSP: true, supportFetchAPI: true } },
]);

app.whenReady().then(async () => {
  // Handle flowmind:// protocol for serving local files
  protocol.handle("flowmind", (request) => {
    const filePath = decodeURIComponent(request.url.replace("flowmind://file/", ""));
    return net.fetch(`file://${filePath}`);
  });
  flowStore = new FlowStore();
  await flowStore.ensureDirectories();

  flowEngine = new FlowDetectionEngine(flowStore);
  interviewEngine = new InterviewEngine(flowStore);
  captureOrchestrator = new CaptureOrchestrator();

  // Forward capture stats to renderer
  captureOrchestrator.on("stats", (stats) => {
    mainWindow?.webContents.send("capture:stats", stats);
  });

  setupIPC();
  createTray();
  createWindow();

  // Run detection every 60 minutes
  detectionInterval = setInterval(runDetection, 60 * 60 * 1000);

  // Auto-cleanup analyzed sessions every hour
  cleanupInterval = setInterval(() => runCleanup(), 60 * 60 * 1000);
});

app.on("window-all-closed", () => {
  // Don't quit — keep running in tray
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on("before-quit", async () => {
  if (detectionInterval) clearInterval(detectionInterval);
  if (cleanupInterval) clearInterval(cleanupInterval);
  await captureOrchestrator.stop();
  tray = null;
});
