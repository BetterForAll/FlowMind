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

  static async listAllSessions(): Promise<SessionInfo[]> {
    const sessions: SessionInfo[] = [];
    if (!fs.existsSync(BASE_DIR)) return sessions;

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

        const info = await CaptureStorage.getSessionInfo(sessionPath, dateDir, sessionDir);
        if (info) sessions.push(info);
      }
    }
    // Sort by start time, newest first
    sessions.sort((a, b) =>
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
    return sessions;
  }

  private static async getSessionInfo(
    sessionPath: string,
    dateDir: string,
    sessionDir: string
  ): Promise<SessionInfo | null> {
    try {
      const eventsFile = path.join(sessionPath, "events.jsonl");
      let eventCount = 0;
      let startedAt: string | null = null;
      let endedAt: string | null = null;

      if (fs.existsSync(eventsFile)) {
        const content = await fsp.readFile(eventsFile, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());
        eventCount = lines.length;
        if (lines.length > 0) {
          try {
            const first = JSON.parse(lines[0]);
            startedAt = first.ts;
            const last = JSON.parse(lines[lines.length - 1]);
            endedAt = last.ts;
          } catch { /* skip */ }
        }
      }

      const ssDir = path.join(sessionPath, "screenshots");
      const screenshotCount = fs.existsSync(ssDir)
        ? (await fsp.readdir(ssDir)).filter((f) => f.endsWith(".jpg")).length
        : 0;

      const audioDir = path.join(sessionPath, "audio");
      const audioChunkCount = fs.existsSync(audioDir)
        ? (await fsp.readdir(audioDir)).filter((f) => f.endsWith(".webm")).length
        : 0;

      const sizeBytes = await CaptureStorage.getDirSize(sessionPath);

      // Check if analyzed marker exists
      const analyzed = fs.existsSync(path.join(sessionPath, ".analyzed"));

      return {
        id: sessionDir,
        date: dateDir,
        path: sessionPath,
        startedAt: startedAt ?? new Date(0).toISOString(),
        endedAt,
        eventCount,
        screenshotCount,
        audioChunkCount,
        sizeBytes,
        analyzed,
      };
    } catch {
      return null;
    }
  }

  static async getSessionScreenshots(sessionPath: string): Promise<string[]> {
    const ssDir = path.join(sessionPath, "screenshots");
    if (!fs.existsSync(ssDir)) return [];
    const files = await fsp.readdir(ssDir);
    return files
      .filter((f) => f.endsWith(".jpg"))
      .sort()
      .map((f) => path.join(ssDir, f));
  }

  static async getSessionAudioFiles(sessionPath: string): Promise<string[]> {
    const audioDir = path.join(sessionPath, "audio");
    if (!fs.existsSync(audioDir)) return [];
    const files = await fsp.readdir(audioDir);
    return files
      .filter((f) => f.endsWith(".webm"))
      .sort()
      .map((f) => path.join(audioDir, f));
  }

  static async deleteSession(sessionPath: string): Promise<void> {
    await fsp.rm(sessionPath, { recursive: true, force: true });
    // Clean up empty date directory
    const parentDir = path.dirname(sessionPath);
    const remaining = await fsp.readdir(parentDir);
    if (remaining.length === 0) {
      await fsp.rm(parentDir, { recursive: true, force: true });
    }
  }

  static async markAnalyzed(sessionPaths: string[]): Promise<void> {
    for (const sp of sessionPaths) {
      await fsp.writeFile(path.join(sp, ".analyzed"), new Date().toISOString(), "utf-8");
    }
  }

  static async cleanupAnalyzed(maxAgeMs: number): Promise<number> {
    let deleted = 0;
    const sessions = await CaptureStorage.listAllSessions();
    const now = Date.now();

    for (const session of sessions) {
      if (!session.analyzed) continue;
      const analyzedFile = path.join(session.path, ".analyzed");
      if (!fs.existsSync(analyzedFile)) continue;

      const analyzedAt = await fsp.readFile(analyzedFile, "utf-8");
      const analyzedTime = new Date(analyzedAt.trim()).getTime();
      if (now - analyzedTime > maxAgeMs) {
        await CaptureStorage.deleteSession(session.path);
        deleted++;
      }
    }
    return deleted;
  }

  private static async getDirSize(dirPath: string): Promise<number> {
    let size = 0;
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += await CaptureStorage.getDirSize(fullPath);
      } else {
        const stat = await fsp.stat(fullPath);
        size += stat.size;
      }
    }
    return size;
  }

  static async getTotalSize(): Promise<number> {
    if (!fs.existsSync(BASE_DIR)) return 0;
    return CaptureStorage.getDirSize(BASE_DIR);
  }
}

export interface SessionInfo {
  id: string;
  date: string;
  path: string;
  startedAt: string;
  endedAt: string | null;
  eventCount: number;
  screenshotCount: number;
  audioChunkCount: number;
  sizeBytes: number;
  analyzed: boolean;
}
