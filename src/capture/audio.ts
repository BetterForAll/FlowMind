import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import type { CaptureStorage } from "./storage";

const GRACE_PERIOD_MS = 15_000; // Keep recording 15s after mic goes silent

export class AudioCapture extends EventEmitter {
  private running = false;
  private storage: CaptureStorage;
  private window: BrowserWindow | null = null;
  private chunkIndex = 0;
  private autoMode = true;
  private manualOverride = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private monitoringStarted = false;

  constructor(storage: CaptureStorage) {
    super();
    this.storage = storage;
  }

  setWindow(window: BrowserWindow): void {
    this.window = window;
  }

  /** Start mic level monitoring in the renderer */
  startAutoDetection(): void {
    if (this.monitoringStarted || !this.autoMode || !this.window) {
      console.log(`[Audio] startAutoDetection skipped: monitoring=${this.monitoringStarted}, auto=${this.autoMode}, window=${!!this.window}`);
      return;
    }
    this.monitoringStarted = true;
    console.log("[Audio] Sending startMonitoring to renderer");
    this.window.webContents.send("audio:startMonitoring");
  }

  stopAutoDetection(): void {
    if (!this.monitoringStarted) return;
    this.monitoringStarted = false;
    this.window?.webContents.send("audio:stopMonitoring");
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  /** Called from main process when renderer reports mic level */
  onMicLevel(level: number): void {
    if (!this.autoMode || this.manualOverride) return;

    const isActive = level > 0.02;
    if (isActive) {
      console.log(`[Audio] Mic level: ${level.toFixed(3)} — ACTIVE`);
    }

    if (isActive && !this.running) {
      // Speech detected — start recording
      if (this.graceTimer) {
        clearTimeout(this.graceTimer);
        this.graceTimer = null;
      }
      this.start();
      this.emit("auto-started", { reason: "speech detected" });
    } else if (!isActive && this.running && !this.manualOverride) {
      // Silence — start grace period
      if (!this.graceTimer) {
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null;
          if (this.running && !this.manualOverride) {
            this.stop();
            this.emit("auto-stopped", { reason: "silence" });
          }
        }, GRACE_PERIOD_MS);
      }
    } else if (isActive && this.running && this.graceTimer) {
      // Speech resumed during grace period — cancel stop
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  startManual(): void {
    this.manualOverride = true;
    this.start();
  }

  stopManual(): void {
    this.manualOverride = false;
    this.stop();
  }

  start(): void {
    if (this.running || !this.window) return;
    this.running = true;
    this.chunkIndex = 0;
    this.window.webContents.send("audio:startRecording");
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.window?.webContents.send("audio:stopRecording");
  }

  isRunning(): boolean {
    return this.running;
  }

  isAutoMode(): boolean {
    return this.autoMode;
  }

  setAutoMode(enabled: boolean): void {
    this.autoMode = enabled;
    if (enabled) {
      this.startAutoDetection();
    } else {
      this.stopAutoDetection();
    }
  }

  async handleChunk(buffer: Buffer): Promise<void> {
    if (!this.running) return;
    await this.storage.saveAudioChunk(buffer, this.chunkIndex++);
  }
}
