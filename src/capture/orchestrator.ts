import { EventEmitter } from "node:events";
import { InputCapture } from "./input";
import { WindowTracker } from "./window-tracker";
import { ScreenshotCapture } from "./screenshot";
import { AudioCapture } from "./audio";
import { SessionManager } from "./session";
import { CaptureStorage } from "./storage";
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

    this.input.start();
    await this.windowTracker.start();
    this.screenshot.start();

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

    await this.storage.stopSession();
    this.session.stop();
    this.capturing = false;
  }

  isCapturing(): boolean {
    return this.capturing;
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
    if (enabled && this.capturing) {
      this.audio.start();
    } else {
      this.audio.stop();
    }
  }

  async handleAudioChunk(buffer: Buffer): Promise<void> {
    await this.audio.handleChunk(buffer);
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
