import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import type { CaptureStorage } from "./storage";

// Audio capture runs in the renderer process (needs Web APIs).
// The main process tells the renderer to start/stop via IPC,
// and the renderer sends back audio chunks via IPC.

export class AudioCapture extends EventEmitter {
  private running = false;
  private storage: CaptureStorage;
  private window: BrowserWindow | null = null;
  private chunkIndex = 0;

  constructor(storage: CaptureStorage) {
    super();
    this.storage = storage;
  }

  setWindow(window: BrowserWindow): void {
    this.window = window;
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
    this.window?.webContents.send("audio:stop");
  }

  isRunning(): boolean {
    return this.running;
  }

  async handleChunk(buffer: Buffer): Promise<void> {
    if (!this.running) return;
    await this.storage.saveAudioChunk(buffer, this.chunkIndex++);
  }
}
