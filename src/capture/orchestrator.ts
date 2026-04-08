import { EventEmitter } from "node:events";
import { InputCapture } from "./input";
import { WindowTracker } from "./window-tracker";
import { ScreenshotCapture } from "./screenshot";
import { AudioCapture } from "./audio";
import { SessionManager } from "./session";
import { CaptureStorage } from "./storage";
import { loadConfig } from "../config";
import { getEffectiveSettings } from "../ai/mode-presets";
import type { CaptureEvent, CaptureStats } from "../types";
import type { BrowserWindow } from "electron";

export class CaptureOrchestrator extends EventEmitter {
  private input: InputCapture;
  private windowTracker: WindowTracker;
  private screenshot: ScreenshotCapture;
  private audio: AudioCapture;
  private session: SessionManager;
  private storage: CaptureStorage;
  private capturing = false;
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  private lastSessionDir: string | null = null;

  constructor() {
    super();
    this.storage = new CaptureStorage();
    this.input = new InputCapture();
    this.windowTracker = new WindowTracker();
    this.screenshot = new ScreenshotCapture(this.storage);
    this.audio = new AudioCapture(this.storage);
    this.session = new SessionManager();

    // Wire up events
    this.input.on("event", (e: CaptureEvent) => this.handleEvent(e));
    this.windowTracker.on("event", (e: CaptureEvent) => this.handleEvent(e));
    this.screenshot.on("event", (e: CaptureEvent) => this.handleEvent(e));
  }

  setWindow(window: BrowserWindow): void {
    this.audio.setWindow(window);
  }

  async start(): Promise<void> {
    if (this.capturing) return;
    this.capturing = true;

    const sessionId = this.session.start(() => this.handleSegment());
    await this.storage.startSession(sessionId);

    // Log session start
    this.storage.appendEvent({
      ts: new Date().toISOString(),
      type: "session-start",
      data: { sessionId },
    });

    // Apply mode settings to screenshot capture
    const config = await loadConfig();
    const settings = getEffectiveSettings(config);
    this.screenshot.configure({
      resolution: settings.resolution,
      jpegQuality: settings.jpegQuality,
    });

    this.input.start();
    await this.windowTracker.start();
    this.screenshot.start();
    this.audio.start();

    // Emit stats every second
    this.statsInterval = setInterval(() => {
      this.emit("stats", this.getStats());
    }, 1000);
  }

  async stop(): Promise<void> {
    if (!this.capturing) return;

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    this.input.stop();
    this.windowTracker.stop();
    this.screenshot.stop();
    this.audio.stop();

    // Log session end
    this.storage.appendEvent({
      ts: new Date().toISOString(),
      type: "session-end",
      data: { ...this.storage.getStats() },
    });

    // Save session dir before closing — audio chunks may arrive after stop
    this.lastSessionDir = this.storage.getSessionDir();

    // Wait a bit for audio to arrive from renderer before closing session
    await new Promise((resolve) => setTimeout(resolve, 2000));

    await this.storage.stopSession();
    this.session.stop();
    this.capturing = false;
  }

  isCapturing(): boolean {
    return this.capturing;
  }

  getActiveSessionDir(): string | null {
    return this.storage.getSessionDir();
  }

  getStats(): CaptureStats {
    const storageStats = this.storage.getStats();
    return {
      capturing: this.capturing,
      sessionId: this.session.getSessionId(),
      sessionStartedAt: this.session.getStartedAt()?.toISOString() ?? null,
      sessionDuration: this.session.getDurationMs(),
      eventCount: storageStats.eventCount,
      screenshotCount: storageStats.screenshotCount,
      audioEnabled: this.audio.isRunning(),
    };
  }

  toggleAudio(enabled: boolean): void {
    if (enabled) {
      this.audio.start();
    } else {
      this.audio.stop();
    }
  }

  async handleAudioChunk(buffer: Buffer): Promise<void> {
    // Try normal save first, fall back to lastSessionDir if session already closed
    const sessionDir = this.storage.getSessionDir() ?? this.lastSessionDir;
    if (!sessionDir) return;

    const fsp = await import("node:fs/promises");
    const pathMod = await import("node:path");
    const audioDir = pathMod.join(sessionDir, "audio");
    await fsp.mkdir(audioDir, { recursive: true });

    // Save as timestamped file — each recording session produces one file
    const filename = `recording-${Date.now()}.webm`;
    const filePath = pathMod.join(audioDir, filename);
    await fsp.writeFile(filePath, buffer);
    console.log(`[Audio] Saved ${(buffer.length / 1024).toFixed(1)} KB to ${filename}`);
  }

  private handleEvent(event: CaptureEvent): void {
    this.session.recordActivity();
    this.storage.appendEvent(event);

    // Take screenshot on meaningful actions
    if (event.type === "click" || event.type === "window-change") {
      this.screenshot.capture();
    }
    if (event.type === "keypress") {
      // Screenshot on Enter key (keycode 28 in uiohook)
      const keycode = event.data.keycode as number;
      if (keycode === 28 || keycode === 36) {
        this.screenshot.capture();
      }
    }

  }

  private async handleSegment(): Promise<void> {
    // Auto-segment: stop current session and start new one
    this.storage.appendEvent({
      ts: new Date().toISOString(),
      type: "session-end",
      data: { reason: "auto-segment", ...this.storage.getStats() },
    });
    await this.storage.stopSession();

    const newId = this.session.segment();
    await this.storage.startSession(newId);
    this.storage.appendEvent({
      ts: new Date().toISOString(),
      type: "session-start",
      data: { sessionId: newId, reason: "auto-segment" },
    });
  }
}
