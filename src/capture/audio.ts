import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import type { CaptureStorage } from "./storage";
import { isMicrophoneInUse } from "./mic-detector";

const MIC_POLL_INTERVAL_MS = 3000; // Check mic status every 3 seconds
const GRACE_PERIOD_MS = 15_000;    // Keep recording 15s after mic goes inactive

export class AudioCapture extends EventEmitter {
  private running = false;
  private storage: CaptureStorage;
  private window: BrowserWindow | null = null;
  private chunkIndex = 0;
  private autoMode = true;
  private manualOverride = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(storage: CaptureStorage) {
    super();
    this.storage = storage;
  }

  setWindow(window: BrowserWindow): void {
    this.window = window;
  }

  /** Start polling for microphone activity */
  startAutoDetection(): void {
    if (this.pollInterval || !this.autoMode) return;

    this.pollInterval = setInterval(async () => {
      if (this.manualOverride) return;

      const micActive = await isMicrophoneInUse();

      if (micActive && !this.running) {
        // Mic just became active — start recording
        if (this.graceTimer) {
          clearTimeout(this.graceTimer);
          this.graceTimer = null;
        }
        this.start();
        this.emit("auto-started", { reason: "microphone active" });
      } else if (!micActive && this.running && !this.manualOverride) {
        // Mic went inactive — start grace period before stopping
        if (!this.graceTimer) {
          this.graceTimer = setTimeout(() => {
            this.graceTimer = null;
            if (this.running && !this.manualOverride) {
              this.stop();
              this.emit("auto-stopped", { reason: "microphone inactive" });
            }
          }, GRACE_PERIOD_MS);
        }
      } else if (micActive && this.running && this.graceTimer) {
        // Mic came back during grace period — cancel stop
        clearTimeout(this.graceTimer);
        this.graceTimer = null;
      }
    }, MIC_POLL_INTERVAL_MS);
  }

  stopAutoDetection(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  /** Manual start (user clicks toggle) */
  startManual(): void {
    this.manualOverride = true;
    this.start();
  }

  /** Manual stop (user clicks toggle) */
  stopManual(): void {
    this.manualOverride = false;
    this.stop();
  }

  start(): void {
    if (this.running || !this.window) return;
    this.running = true;
    this.chunkIndex = 0;
    this.window.webContents.send("audio:start");
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.window?.webContents.send("audio:stop");
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
