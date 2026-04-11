import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, protocol, net, shell } from "electron";
import path from "node:path";
import dotenv from "dotenv";

// Load .env — in packaged builds, look next to the exe; in dev, use app path
const envPath = app.isPackaged
  ? path.join(path.dirname(app.getPath("exe")), ".env")
  : path.join(app.getAppPath(), ".env");
dotenv.config({ path: envPath });
import { FlowDetectionEngine } from "./engine/flow-detection";
import { FlowStore } from "./engine/flow-store";
import { InterviewEngine } from "./engine/interview";
import { DescribeEngine } from "./engine/describe";
import { DescriptionStore } from "./engine/description-store";
import { CaptureOrchestrator } from "./capture/orchestrator";
import { CaptureStorage } from "./capture/storage";
import { loadConfig, saveConfig, type AppConfig } from "./config";
import { getEffectiveSettings } from "./ai/mode-presets";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let flowEngine: FlowDetectionEngine;
let flowStore: FlowStore;
let descriptionStore: DescriptionStore;
let describeEngine: DescribeEngine;
let interviewEngine: InterviewEngine;
let captureOrchestrator: CaptureOrchestrator;
let describeInterval: ReturnType<typeof setInterval> | null = null;
let analyzeInterval: ReturnType<typeof setInterval> | null = null;

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
          const sessionDir = captureOrchestrator.getActiveSessionDir();
          const sessionId = captureOrchestrator.getStats().sessionId;
          await captureOrchestrator.stop();
          runPostCaptureSequence(sessionDir, sessionId);
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
  // Create a simple 16x16 icon (Windows requires a non-empty tray icon)
  const icon = nativeImage.createFromBuffer(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVQ4T2NkYPj/n4EBCBgZGRkYQWwUwMjIyIiqAMVsJBcMehdQHAijYTAaBhSHAQBCfQgRsUb6MAAAAABJRU5ErkJggg==",
      "base64"
    ),
    { width: 16, height: 16 }
  );
  tray = new Tray(icon);

  updateTrayMenu();

  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

/**
 * Phase 1 — describe the most recent window of the active capture session.
 * Safe to call at any time; no-ops if not capturing or describe engine is busy.
 */
async function runDescribe(): Promise<void> {
  try {
    if (!captureOrchestrator.isCapturing()) return;
    if (describeEngine.isRunning()) return;

    const sessionDir = captureOrchestrator.getActiveSessionDir();
    if (!sessionDir) return;
    const sessionId = captureOrchestrator.getStats().sessionId;
    if (!sessionId) return;

    await describeEngine.describeWindow(sessionDir, sessionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Describe failed:", message);
  }
}

/**
 * Phase 2 — run flow detection over all unanalyzed descriptions.
 * Pure text, fast, no screenshots sent.
 */
async function runDetection(): Promise<void> {
  try {
    mainWindow?.webContents.send("detection:status", "running");
    const results = await flowEngine.detectFlows();
    mainWindow?.webContents.send("detection:status", "idle");
    mainWindow?.webContents.send("detection:results", results);

    await runCleanup();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Detection failed:", message);
    mainWindow?.webContents.send("detection:status", "error");
    mainWindow?.webContents.send("detection:error", message);
  }
}

/**
 * Cleanup runs two independent passes:
 *  1. Raw session cleanup — driven by cleanupMode
 *  2. Description cleanup — driven by descriptionRetentionMinutes
 */
async function runCleanup(): Promise<void> {
  try {
    const config = await loadConfig();
    const activeDir = captureOrchestrator.getActiveSessionDir();

    // --- Raw session cleanup ---
    if (config.cleanupMode === "after-described") {
      const deleted = await CaptureStorage.cleanupDescribed(activeDir);
      if (deleted > 0) {
        console.log(`Cleanup: deleted ${deleted} described sessions (mode: after-described)`);
      }
    } else {
      const maxAgeMs = config.cleanupMode === "after-analysis"
        ? 0
        : config.cleanupMode === "1h"
          ? 60 * 60 * 1000
          : config.cleanupMode === "4h"
            ? 4 * 60 * 60 * 1000
            : Infinity;
      if (maxAgeMs !== Infinity) {
        const deleted = await CaptureStorage.cleanupAnalyzed(maxAgeMs, activeDir);
        if (deleted > 0) {
          console.log(`Cleanup: deleted ${deleted} analyzed sessions (mode: ${config.cleanupMode})`);
        }
      }
    }

    // --- Description cleanup (age-based, linked descriptions are always kept) ---
    const settings = getEffectiveSettings(config);
    const retentionMs = settings.descriptionRetentionMinutes * 60 * 1000;
    const deletedDescs = await descriptionStore.cleanupOld(retentionMs);
    if (deletedDescs > 0) {
      console.log(`Cleanup: deleted ${deletedDescs} descriptions older than ${settings.descriptionRetentionMinutes} min (linked kept)`);
    }
  } catch (err) {
    console.error("Cleanup failed:", err);
  }
}

/**
 * Capture-stop sequence: final describe pass over any remaining window,
 * then full phase-2 detection, then cleanup. Called from tray and IPC handlers.
 */
async function runPostCaptureSequence(sessionDir: string | null, sessionId: string | null): Promise<void> {
  try {
    if (sessionDir && sessionId) {
      // Flush the tail window. Describe calls are queued serially, so this will run
      // after any interval-triggered describe that's still in flight.
      await describeEngine.describeWindow(sessionDir, sessionId).catch((err) => {
        console.error("Final describe failed:", err);
      });
      // Double-safety: wait for any other queued describe calls to fully drain before detection.
      await describeEngine.waitForIdle();
      // Mark session as fully described so after-described cleanup can reclaim it.
      await CaptureStorage.markDescribed([sessionDir]).catch(() => {});
    }
  } finally {
    await runDetection();
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

  // Descriptions (phase-1 artifacts)
  ipcMain.handle("descriptions:getAll", async () => {
    return descriptionStore.getAllDescriptions();
  });

  ipcMain.handle("descriptions:getByWindowStarts", async (_e, windowStarts: string[]) => {
    if (!Array.isArray(windowStarts) || windowStarts.length === 0) return [];
    const wanted = new Set(windowStarts);
    const all = await descriptionStore.getAllDescriptions();
    return all.filter((d) => wanted.has(d.frontmatter.windowStart));
  });

  ipcMain.handle("descriptions:getKeyScreenshots", async (_e, descriptionFilePath: string) => {
    return descriptionStore.getKeyScreenshotPaths(descriptionFilePath);
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
    const sessionDir = captureOrchestrator.getActiveSessionDir();
    const sessionId = captureOrchestrator.getStats().sessionId;
    await captureOrchestrator.stop();
    updateTrayMenu();
    // Final phase-1 flush + phase-2 detection
    runPostCaptureSequence(sessionDir, sessionId);
  });

  ipcMain.handle("capture:getStats", () => {
    return captureOrchestrator.getStats();
  });

  ipcMain.handle("capture:toggleAudio", (_e, enabled: boolean) => {
    captureOrchestrator.toggleAudio(enabled);
  });

  // Audio from renderer
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

  ipcMain.handle("sessions:getAudioFiles", async (_e, sessionPath: string) => {
    return CaptureStorage.getSessionAudioFiles(sessionPath);
  });

  // Return audio file as base64 data URL for reliable playback
  ipcMain.handle("sessions:getAudioDataUrl", async (_e, filePath: string) => {
    const fsp = await import("node:fs/promises");
    const buffer = await fsp.readFile(filePath);
    const base64 = buffer.toString("base64");
    return `data:audio/webm;base64,${base64}`;
  });

  ipcMain.handle("sessions:delete", async (_e, sessionPath: string) => {
    await CaptureStorage.deleteSession(sessionPath);
  });

  ipcMain.handle("sessions:deleteAnalyzed", async () => {
    return CaptureStorage.cleanupAnalyzed(0, captureOrchestrator.getActiveSessionDir());
  });

  ipcMain.handle("sessions:getTotalSize", async () => {
    return CaptureStorage.getTotalSize();
  });

  // Interview
  ipcMain.handle("interview:getQuestions", async (_e, flowId: string) => {
    return interviewEngine.getQuestions(flowId);
  });

  ipcMain.handle(
    "interview:submitAllAnswers",
    async (_e, flowId: string, answers: Record<number, string>) => {
      return interviewEngine.submitAllAnswers(flowId, answers);
    }
  );

  ipcMain.handle("interview:generateAutomation", async (_e, flowId: string, format: string) => {
    return interviewEngine.generateAutomation(flowId, format);
  });

  // Automations — list, read, open, reveal, delete
  ipcMain.handle("automations:listForFlow", async (_e, flowName: string) => {
    return flowStore.listAutomationsForFlow(flowName);
  });

  ipcMain.handle("automations:readFile", async (_e, filePath: string) => {
    return flowStore.readAutomation(filePath);
  });

  ipcMain.handle("automations:open", async (_e, filePath: string) => {
    const err = await shell.openPath(filePath);
    if (err) throw new Error(err);
  });

  ipcMain.handle("automations:revealInExplorer", async (_e, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle("automations:delete", async (_e, filePath: string) => {
    await flowStore.deleteAutomation(filePath);
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
  try {
  // Handle flowmind:// protocol for serving local files
  protocol.handle("flowmind", async (request) => {
    // Convert flowmind://file/<encoded-path> to a local file path
    let filePath = request.url.replace("flowmind://file/", "");
    filePath = decodeURIComponent(filePath);
    // On Windows, ensure proper drive letter path (C:/...)
    if (process.platform === "win32" && /^[A-Za-z]:/.test(filePath)) {
      // Already a valid Windows path
    }
    return net.fetch(`file:///${filePath}`);
  });
  flowStore = new FlowStore();
  await flowStore.ensureDirectories();

  descriptionStore = new DescriptionStore();
  await descriptionStore.ensureDirectory();

  describeEngine = new DescribeEngine(descriptionStore);
  flowEngine = new FlowDetectionEngine(flowStore, descriptionStore);
  interviewEngine = new InterviewEngine(flowStore);
  captureOrchestrator = new CaptureOrchestrator();

  // Forward capture stats to renderer
  captureOrchestrator.on("stats", (stats) => {
    mainWindow?.webContents.send("capture:stats", stats);
  });

  setupIPC();
  createTray();
  createWindow();

  // Two-phase scheduling:
  //  - describeInterval: frequent (default 1 min) — turns raw capture into text narratives
  //  - analyzeInterval: less frequent (default 10 min) — turns narratives into flows
  const config = await loadConfig();
  const describeMs = config.describeIntervalMinutes * 60 * 1000;
  const analyzeMs = config.analyzeIntervalMinutes * 60 * 1000;

  describeInterval = setInterval(runDescribe, describeMs);
  analyzeInterval = setInterval(runDetection, analyzeMs);

  console.log(
    `[FlowMind] Describe interval: ${config.describeIntervalMinutes} min, ` +
    `Analyze interval: ${config.analyzeIntervalMinutes} min`
  );
  } catch (err) {
    const { dialog } = require("electron");
    dialog.showErrorBox("FlowMind startup error", String(err));
  }
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
  if (describeInterval) clearInterval(describeInterval);
  if (analyzeInterval) clearInterval(analyzeInterval);
  await captureOrchestrator.stop();
  tray = null;
});
