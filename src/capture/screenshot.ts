import { desktopCapturer, nativeImage } from "electron";
import { EventEmitter } from "node:events";
import type { CaptureEvent } from "../types";
import type { CaptureStorage } from "./storage";

const MIN_INTERVAL_MS = 2000; // Throttle: max 1 screenshot per 2 seconds

export class ScreenshotCapture extends EventEmitter {
  private running = false;
  private storage: CaptureStorage;
  private lastCapture = 0;

  constructor(storage: CaptureStorage) {
    super();
    this.storage = storage;
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
        thumbnailSize: { width: 1920, height: 1080 },
      });

      if (sources.length === 0) return;

      const thumbnail = sources[0].thumbnail;
      const jpegBuffer = thumbnail.toJPEG(70);

      if (!this.storage.getSessionDir()) return; // Session may have ended
      const filePath = await this.storage.saveScreenshot(
        Buffer.from(jpegBuffer),
        now
      );

      const event: CaptureEvent = {
        ts: new Date(now).toISOString(),
        type: "screenshot",
        data: { file: filePath },
      };
      this.emit("event", event);
    } catch (err) {
      console.error("Screenshot capture failed:", err);
    }
  }
}
