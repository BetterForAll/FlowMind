import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { CaptureEvent } from "../types";

const BASE_DIR = path.join(os.homedir(), "flowmind-data", "sessions");

export class CaptureStorage {
  private sessionDir: string | null = null;
  private eventsStream: fs.WriteStream | null = null;
  private eventCount = 0;
  private screenshotCount = 0;

  async startSession(sessionId: string): Promise<string> {
    const date = new Date().toISOString().slice(0, 10);
    this.sessionDir = path.join(BASE_DIR, date, sessionId);
    await fsp.mkdir(path.join(this.sessionDir, "screenshots"), { recursive: true });
    await fsp.mkdir(path.join(this.sessionDir, "audio"), { recursive: true });

    const eventsPath = path.join(this.sessionDir, "events.jsonl");
    this.eventsStream = fs.createWriteStream(eventsPath, { flags: "a" });
    this.eventCount = 0;
    this.screenshotCount = 0;

    return this.sessionDir;
  }

  async stopSession(): Promise<void> {
    if (this.eventsStream) {
      this.eventsStream.end();
      this.eventsStream = null;
    }
    this.sessionDir = null;
  }

  appendEvent(event: CaptureEvent): void {
    if (!this.eventsStream) return;
    this.eventsStream.write(JSON.stringify(event) + "\n");
    this.eventCount++;
  }

  async saveScreenshot(jpegBuffer: Buffer, timestamp: number): Promise<string> {
    if (!this.sessionDir) throw new Error("No active session");
    const filename = `${timestamp}.jpg`;
    const filePath = path.join(this.sessionDir, "screenshots", filename);
    await fsp.writeFile(filePath, jpegBuffer);
    this.screenshotCount++;
    return filePath;
  }

  async saveAudioChunk(buffer: Buffer, chunkIndex: number): Promise<string> {
    if (!this.sessionDir) throw new Error("No active session");
    const filename = `chunk-${String(chunkIndex).padStart(3, "0")}.webm`;
    const filePath = path.join(this.sessionDir, "audio", filename);
    await fsp.writeFile(filePath, buffer);
    return filePath;
  }

  getStats() {
    return { eventCount: this.eventCount, screenshotCount: this.screenshotCount };
  }

  getSessionDir(): string | null {
    return this.sessionDir;
  }

  static getBaseDir(): string {
    return BASE_DIR;
  }

  static async getRecentSessionDirs(since: Date): Promise<string[]> {
    const dirs: string[] = [];
    if (!fs.existsSync(BASE_DIR)) return dirs;

    const dateDirs = await fsp.readdir(BASE_DIR);
    for (const dateDir of dateDirs.sort().reverse()) {
      const datePath = path.join(BASE_DIR, dateDir);
      const stat = await fsp.stat(datePath);
      if (!stat.isDirectory()) continue;

      const sessionDirs = await fsp.readdir(datePath);
      for (const sessionDir of sessionDirs.sort().reverse()) {
        const sessionPath = path.join(datePath, sessionDir);
        const sessionStat = await fsp.stat(sessionPath);
        if (!sessionStat.isDirectory()) continue;
        if (sessionStat.mtime >= since) {
          dirs.push(sessionPath);
        }
      }
    }
    return dirs;
  }
}
