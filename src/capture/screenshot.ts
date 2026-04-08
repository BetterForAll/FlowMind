import { desktopCapturer, nativeImage } from "electron";
import { EventEmitter } from "node:events";
import type { CaptureEvent } from "../types";
import type { CaptureStorage } from "./storage";

const MIN_INTERVAL_MS = 2000; // Throttle: max 1 screenshot per 2 seconds

export class ScreenshotCapture extends EventEmitter {
  private running = false;
  private storage: CaptureStorage;
  private lastCapture = 0;
  private resolution = { width: 1920, height: 1080 };
  private jpegQuality = 70;

  constructor(storage: CaptureStorage) {
    super();
    this.storage = storage;
  }

  configure(opts: { resolution?: { width: number; height: number }; jpegQuality?: number }): void {
    if (opts.resolution) this.resolution = opts.resolution;
    if (opts.jpegQuality) this.jpegQuality = opts.jpegQuality;
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  async capture(): Promise<void> {
    if (!this.running) return;

    const now = Date.now();
    if (now - this.lastCapture < MIN_INTERVAL_MS) return;
    this.lastCapture = now;

    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: this.resolution,
      });

      if (sources.length === 0) return;
      if (!this.storage.getSessionDir()) return;

      // Capture ALL screens, not just the first one
      for (let i = 0; i < sources.length; i++) {
        const thumbnail = sources[i].thumbnail;
        if (thumbnail.isEmpty()) continue;

        const jpegBuffer = thumbnail.toJPEG(this.jpegQuality);
        const timestamp = now + i; // Offset by 1ms per screen to avoid filename collision

        const filePath = await this.storage.saveScreenshot(
          Buffer.from(jpegBuffer),
          timestamp
        );

        const event: CaptureEvent = {
          ts: new Date(now).toISOString(),
          type: "screenshot",
          data: { file: filePath, screen: i, screenName: sources[i].name },
        };
        this.emit("event", event);
      }
    } catch (err) {
      console.error("Screenshot capture failed:", err);
    }
  }
}
