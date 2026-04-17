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
import { AutomationRunner, type RunEvent } from "./engine/automation-runner";
import { AutoFixOrchestrator, type AutoFixEvent } from "./engine/auto-fix-orchestrator";
import { ScriptDoctor } from "./engine/script-doctor";
import { AgentExecutor } from "./engine/agent-executor";
import { ScriptSynthesizer } from "./engine/script-synthesizer";
import type { AgentEvent } from "./engine/agent-types";
import { CaptureOrchestrator } from "./capture/orchestrator";
import { randomUUID } from "node:crypto";
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
let automationRunner: AutomationRunner;
let autoFixOrchestrator: AutoFixOrchestrator | null = null;
let agentExecutor: AgentExecutor | null = null;
let scriptSynthesizer: ScriptSynthesizer | null = null;
let captureOrchestrator: CaptureOrchestrator;
/**
 * Pending ask_user prompts. The agent executor calls a bridge function
 * that pushes a prompt to the renderer and returns a promise; the
 * renderer answers via the `agent:answerUser` IPC and the promise
 * resolves. Keyed by promptId. Cleared on answer, on agent_finished,
 * or on agent_error.
 */
const pendingAgentPrompts = new Map<string, (answer: string) => void>();

/**
 * Bridge the agent-executor's askUser tool to the renderer. Creates a
 * fresh promptId, pushes the prompt to the renderer over the agent-event
 * channel, and returns a Promise that resolves when the renderer invokes
 * `automations:answerAgentPrompt` with that promptId. No cancellation —
 * if the user closes the app while a prompt is open, the promise never
 * resolves (but the agent's 30-step / 5-error ceilings bound the run).
 */
function bridgeAgentAskUser(
  runId: string,
  prompt: string,
  kind: "text" | "yesno" | "choice",
  choices?: string[]
): Promise<string> {
  const promptId = randomUUID();
  const pending = new Promise<string>((resolve) => {
    pendingAgentPrompts.set(promptId, resolve);
  });
  mainWindow?.webContents.send("automations:agentEvent", {
    type: "agent_asking_user",
    runId,
    promptId,
    prompt,
    kind,
    choices,
  });
  return pending;
}
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

  ipcMain.handle(
    "automations:run",
    async (
      _e,
      filePath: string,
      format: "python" | "nodejs",
      params?: Record<string, string>,
      flowId?: string
    ) => {
      if (format !== "python" && format !== "nodejs") {
        throw new Error(`Run is only supported for python and nodejs automations (got ${format})`);
      }
      // AutomationRunner validates the path; throwing bubbles up to the renderer.
      const runId = automationRunner.run(filePath, format, undefined, params ?? {});

      // Register the run with the auto-fix orchestrator so a non-zero exit
      // triggers the ScriptDoctor automatically (user preference). We need
      // flowId to resolve the flow body + parameters when the doctor is
      // invoked. Older callers may omit it — in that case we still run the
      // script, we just can't auto-fix. If the orchestrator couldn't be
      // constructed (missing API key), we skip silently.
      if (flowId && autoFixOrchestrator) {
        const flow = await flowStore.getFlowById(flowId);
        if (flow) {
          const pathMod = await import("node:path");
          const ext = pathMod.extname(filePath).replace(/^\./, "") || (format === "python" ? "py" : "js");
          autoFixOrchestrator.track(runId, {
            flowId,
            flowName: flow.frontmatter.name,
            flowBody: flow.body,
            parameters: flow.frontmatter.parameters ?? [],
            filePath,
            format,
            params: params ?? {},
            attempt: 1,
            ext,
          });
        }
      }

      return { runId };
    }
  );

  // Manual opt-out — user clicked "don't auto-fix this run" after seeing the
  // script fail. Prevents the orchestrator from kicking in on this run's
  // exit event.
  ipcMain.handle("automations:disableAutoFix", async (_e, runId: string) => {
    autoFixOrchestrator?.disableForRun(runId);
  });

  // Promote a patched script (`<slug>-<format>.vN.<ext>`) to the primary
  // slot — overwrites the primary, deletes the patch. Called when the user
  // approves an auto-fix result as the new canonical version.
  ipcMain.handle("automations:promotePatch", async (_e, patchPath: string) => {
    const primaryPath = await flowStore.promotePatchToPrimary(patchPath);
    return { primaryPath };
  });

  // --- Stage 2: agent-first execution ---------------------------------
  //
  // Run a flow "as an agent" — Gemini function-calling drives real tools
  // instead of us generating a static script up front. Emits
  // `automations:agentEvent` over the channel the renderer subscribes to;
  // returns the runId synchronously so the UI can filter events. The
  // actual run resolves later with the trace; if synthesize=true we also
  // save the trace as a replay script.
  ipcMain.handle(
    "automations:runAsAgent",
    async (
      _e,
      flowId: string,
      params: Record<string, string>,
      opts: {
        synthesize?: boolean;
        format?: "python" | "nodejs";
        /** Tool tier — 1 (default) is Node-only, 2 enables desktop + vision. */
        level?: 1 | 2;
        /** When true, every destructive Level 2 tool call pauses for
         *  user approval via the existing ask_user panel. */
        approveEachStep?: boolean;
        /** When true, the agent's chromium browser launches in headed
         *  mode so the user can watch the agent navigate. Default: headless. */
        headedBrowser?: boolean;
      } = {}
    ) => {
      if (!agentExecutor) {
        throw new Error("Agent mode is disabled — GEMINI_API_KEY is missing.");
      }
      const flow = await flowStore.getFlowById(flowId);
      if (!flow) throw new Error(`Flow not found: ${flowId}`);
      if (flow.frontmatter.type !== "complete-flow") {
        throw new Error("Agent mode only runs on complete flows.");
      }

      const runId = randomUUID();
      const config = await loadConfig();
      const model = getEffectiveSettings(config).automationModel;

      // Kick off the agent run but don't await here — return the runId to
      // the renderer so it can render the live trace, then let the loop
      // resolve in the background. When it finishes, synthesize on demand
      // and send the final "trace_saved" event.
      (async () => {
        try {
          const result = await agentExecutor!.run({
            runId,
            flow,
            params,
            model,
            askUser: bridgeAgentAskUser,
            level: opts.level ?? 1,
            approveEachStep: opts.approveEachStep,
            headedBrowser: opts.headedBrowser,
          });

          // On success, optionally synthesize and save as a replay script.
          if (result.success && opts.synthesize && opts.format && scriptSynthesizer) {
            try {
              const { source } = await scriptSynthesizer.synthesize({
                flow,
                params,
                trace: result.trace,
                format: opts.format,
                model,
              });
              const ext = opts.format === "python" ? "py" : "js";
              const filePath = await flowStore.saveAutomation(
                flow.frontmatter.name,
                source,
                opts.format,
                ext
              );
              mainWindow?.webContents.send("automations:agentEvent", {
                type: "agent_trace_saved",
                runId,
                filePath,
                format: opts.format,
              });
            } catch (err) {
              mainWindow?.webContents.send("automations:agentEvent", {
                type: "agent_synthesize_failed",
                runId,
                reason: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } catch (err) {
          mainWindow?.webContents.send("automations:agentEvent", {
            type: "agent_error",
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();

      return { runId };
    }
  );

  // Resolve a pending ask_user prompt from the renderer.
  ipcMain.handle("automations:answerAgentPrompt", async (_e, promptId: string, answer: string) => {
    const resolve = pendingAgentPrompts.get(promptId);
    if (resolve) {
      pendingAgentPrompts.delete(promptId);
      resolve(answer);
    }
    return { ok: !!resolve };
  });

  // Probe whether the Stage 3 desktop helper is ready (Python present
  // AND required pip packages importable). Used by the UI's "Run with
  // All Tools" button to decide between launching directly and showing
  // the install prompt. Returns { ready, pythonAvailable, missing }.
  ipcMain.handle("automations:checkDesktopReady", async () => {
    const { spawn } = await import("node:child_process");
    const { REQUIRED_DESKTOP_PACKAGES } = await import("./engine/agent-desktop");
    const bin = process.platform === "win32" ? "python" : "python3";
    return new Promise<{ ready: boolean; pythonAvailable: boolean; missing: string[] }>(
      (resolve) => {
        const code = [
          "import importlib.util, sys",
          "for p in sys.argv[1:]:",
          "    if importlib.util.find_spec(p) is None:",
          "        print(p)",
        ].join("\n");
        const child = spawn(bin, ["-c", code, ...REQUIRED_DESKTOP_PACKAGES], {
          shell: false,
          windowsHide: true,
        });
        let stdout = "";
        child.stdout?.on("data", (c) => { stdout += c.toString("utf-8"); });
        child.on("error", () => resolve({ ready: false, pythonAvailable: false, missing: REQUIRED_DESKTOP_PACKAGES }));
        child.on("exit", (code) => {
          const pythonAvailable = code === 0 || stdout.length > 0;
          const missing = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          resolve({
            ready: pythonAvailable && missing.length === 0,
            pythonAvailable,
            missing: pythonAvailable ? missing : REQUIRED_DESKTOP_PACKAGES,
          });
        });
      }
    );
  });

  // Install the missing desktop pip packages via `python -m pip install`.
  // Streams output through the existing automations runner so the UI
  // shows live progress in the run panel — same UX as the script-runner's
  // Install button, just for a fixed package list.
  ipcMain.handle("automations:installDesktopDeps", async () => {
    const { REQUIRED_DESKTOP_PACKAGES } = await import("./engine/agent-desktop");
    const pathMod = await import("node:path");
    // Reuse the AutomationRunner.installDeps path so output streams
    // through the existing automation event channel. cwd doesn't matter
    // for system pip — point it at the automations dir to satisfy the
    // path-safety check inside installDeps.
    const os = await import("node:os");
    const cwd = pathMod.join(os.homedir(), "flowtracker", "automations");
    await (await import("node:fs/promises")).mkdir(cwd, { recursive: true });
    return { runId: automationRunner.installDeps("python", REQUIRED_DESKTOP_PACKAGES, cwd) };
  });

  ipcMain.handle("automations:kill", async (_e, runId: string) => {
    return { killed: automationRunner.kill(runId) };
  });

  ipcMain.handle("automations:sendInput", async (_e, runId: string, text: string) => {
    return { sent: automationRunner.sendInput(runId, text) };
  });

  ipcMain.handle("automations:closeStdin", async (_e, runId: string) => {
    return { closed: automationRunner.closeStdin(runId) };
  });

  ipcMain.handle("automations:listRunLogs", async (_e, flowName: string, format: string) => {
    return flowStore.listRunLogs(flowName, format);
  });

  ipcMain.handle("automations:readRunLog", async (_e, filePath: string) => {
    return flowStore.readRunLog(filePath);
  });

  ipcMain.handle("automations:deleteRunLog", async (_e, filePath: string) => {
    await flowStore.deleteRunLog(filePath);
  });

  ipcMain.handle(
    "automations:getExternalDeps",
    async (_e, filePath: string, format: "python" | "nodejs") => {
      // Only return packages that are actually MISSING from the runtime
      // the script will use. Static import scanning alone produced
      // false-positive install banners for users who already had the
      // package installed.
      const content = await flowStore.readAutomation(filePath);
      const { findMissingDeps } = await import("./engine/dep-detector");
      const pathMod = await import("node:path");
      return findMissingDeps(content, format, pathMod.dirname(filePath));
    }
  );

  ipcMain.handle(
    "automations:installDeps",
    async (_e, filePath: string, format: "python" | "nodejs", packages: string[]) => {
      if (format !== "python" && format !== "nodejs") {
        throw new Error(`Install is only supported for python and nodejs (got ${format})`);
      }
      if (!Array.isArray(packages) || packages.length === 0) {
        throw new Error("installDeps requires a non-empty packages array");
      }
      // Paths: use the directory of the target script so `npm install` puts
      // node_modules next to it, matching what the run step will use as cwd.
      const pathMod = await import("node:path");
      const cwd = pathMod.dirname(filePath);
      return { runId: automationRunner.installDeps(format, packages, cwd) };
    }
  );

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
  automationRunner = new AutomationRunner();
  // Forward runner events to the renderer so the Run panel can stream output live.
  automationRunner.on("event", (event: RunEvent) => {
    mainWindow?.webContents.send("automations:event", event);
  });

  // Auto-fix orchestrator: watches for non-zero exits and, if the user has
  // auto-fix enabled, invokes ScriptDoctor + retries with a versioned patch.
  // Its events ride the same channel as runner events so the renderer has
  // a single subscription point. We gate on GEMINI_API_KEY since the doctor
  // needs it — without a key, new AutoFixOrchestrator would throw.
  try {
    const doctor = new ScriptDoctor();
    autoFixOrchestrator = new AutoFixOrchestrator(
      automationRunner,
      flowStore,
      doctor,
      async () => {
        const c = await loadConfig();
        return getEffectiveSettings(c).automationModel;
      },
      async () => {
        const c = await loadConfig();
        return {
          enabled: c.autoFixOnFailure,
          maxRetries: c.autoFixMaxRetries,
        };
      },
      async (flowId: string) => {
        const f = await flowStore.getFlowById(flowId);
        if (!f) return null;
        return {
          name: f.frontmatter.name,
          body: f.body,
          parameters: f.frontmatter.parameters ?? [],
        };
      }
    );
    autoFixOrchestrator.on("event", (event: AutoFixEvent) => {
      mainWindow?.webContents.send("automations:autoFixEvent", event);
    });
  } catch (err) {
    console.warn(
      "[FlowMind] Auto-fix disabled — ScriptDoctor init failed:",
      err instanceof Error ? err.message : err
    );
  }

  // Agent executor + script synthesizer (Stage 2). Same API-key gating
  // as the doctor — if the key is absent, the Run-as-agent IPC will
  // surface an error back to the UI rather than crash here.
  try {
    agentExecutor = new AgentExecutor();
    scriptSynthesizer = new ScriptSynthesizer();
    agentExecutor.on("event", (event: AgentEvent) => {
      mainWindow?.webContents.send("automations:agentEvent", event);
    });
  } catch (err) {
    console.warn(
      "[FlowMind] Agent mode disabled — init failed:",
      err instanceof Error ? err.message : err
    );
  }
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
