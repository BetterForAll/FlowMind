import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import type { CaptureStorage } from "./storage";

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
    console.log("[Audio] Starting continuous recording (system audio + mic)");
    this.window.webContents.send("audio:startRecording");
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.window?.webContents.send("audio:stopRecording");
    console.log("[Audio] Stopped recording");
  }

  isRunning(): boolean {
    return this.running;
  }

  async handleChunk(buffer: Buffer): Promise<void> {
    if (!this.running) return;
    await this.storage.saveAudioChunk(buffer, this.chunkIndex++);
  }
}
