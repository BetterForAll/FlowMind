import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import type { CaptureStorage } from "./storage";

// Apps and window title patterns that indicate a meeting/call
const MEETING_APPS = new Set([
  "zoom", "zoom.exe",
  "teams", "teams.exe", "ms-teams",
  "discord", "discord.exe",
  "slack", "slack.exe",
  "webex", "ciscowebex",
  "skype", "skype.exe",
  "telegram", "telegram.exe",
  "whatsapp", "whatsapp.exe",
]);

const MEETING_TITLE_PATTERNS = [
  /zoom meeting/i,
  /\bmeet\b.*google/i,
  /google\s*meet/i,
  /meet\.google\.com/i,
  /teams\s*(meeting|call)/i,
  /huddle/i,
  /\bcall\b/i,
  /webex/i,
  /facetime/i,
];

export class AudioCapture extends EventEmitter {
  private running = false;
  private storage: CaptureStorage;
  private window: BrowserWindow | null = null;
  private chunkIndex = 0;
  private autoMode = true; // Auto-detect meetings
  private manualOverride = false; // Manual toggle overrides auto
  private awayTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly awayTimeoutMs = 30_000; // 30 seconds away from meeting app → stop

  constructor(storage: CaptureStorage) {
    super();
    this.storage = storage;
  }

  setWindow(window: BrowserWindow): void {
    this.window = window;
  }

  /** Called by orchestrator when active window changes */
  onWindowChange(app: string, title: string): void {
    if (!this.autoMode || this.manualOverride) return;

    const isMeetingApp = this.isMeetingWindow(app, title);

    if (isMeetingApp) {
      // Clear any pending stop timer
      if (this.awayTimer) {
        clearTimeout(this.awayTimer);
        this.awayTimer = null;
      }
      // Start recording if not already
      if (!this.running) {
        this.start();
        this.emit("auto-started", { app, title });
      }
    } else if (this.running && !this.manualOverride) {
      // User switched away from meeting app — start countdown
      if (!this.awayTimer) {
        this.awayTimer = setTimeout(() => {
          this.awayTimer = null;
          if (this.running && !this.manualOverride) {
            this.stop();
            this.emit("auto-stopped", { reason: "left meeting app" });
          }
        }, this.awayTimeoutMs);
      }
    }
  }

  private isMeetingWindow(app: string, title: string): boolean {
    const appLower = app.toLowerCase();
    if (MEETING_APPS.has(appLower)) return true;
    // Check browser windows for web-based meeting tools
    const combined = `${app} ${title}`;
    return MEETING_TITLE_PATTERNS.some((p) => p.test(combined));
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
    if (this.awayTimer) {
      clearTimeout(this.awayTimer);
      this.awayTimer = null;
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
  }

  async handleChunk(buffer: Buffer): Promise<void> {
    if (!this.running) return;
    await this.storage.saveAudioChunk(buffer, this.chunkIndex++);
  }
}
