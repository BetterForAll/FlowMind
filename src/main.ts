import "dotenv/config";
import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from "electron";
import path from "node:path";
import { FlowDetectionEngine } from "./engine/flow-detection";
import { FlowStore } from "./engine/flow-store";
import { InterviewEngine } from "./engine/interview";
import { CaptureOrchestrator } from "./capture/orchestrator";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let flowEngine: FlowDetectionEngine;
let flowStore: FlowStore;
let interviewEngine: InterviewEngine;
let captureOrchestrator: CaptureOrchestrator;
let detectionInterval: ReturnType<typeof setInterval> | null = null;

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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    mainWindow?.webContents.send("detection:status", "error");
    mainWindow?.webContents.send("detection:error", message);
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
  });

  ipcMain.handle("capture:getStats", () => {
    return captureOrchestrator.getStats();
  });

  ipcMain.handle("capture:toggleAudio", (_e, enabled: boolean) => {
    captureOrchestrator.toggleAudio(enabled);
  });

  // Audio chunks from renderer
  ipcMain.on("audio:chunk", async (_e, buffer: Buffer) => {
    await captureOrchestrator.handleAudioChunk(buffer);
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
  ipcMain.handle("settings:get", () => {
    return {
      detectionIntervalMinutes: 60,
    };
  });
}

app.whenReady().then(async () => {
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
  await captureOrchestrator.stop();
  tray = null;
});
