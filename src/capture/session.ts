import { v4 as uuid } from "uuid";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SESSION_MS = 60 * 60 * 1000;  // 60 minutes

export class SessionManager {
  private sessionId: string | null = null;
  private startedAt: Date | null = null;
  private lastActivity: number = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private onSegment: (() => void) | null = null;

  start(onSegment: () => void): string {
    this.sessionId = `session-${uuid().slice(0, 8)}`;
    this.startedAt = new Date();
    this.lastActivity = Date.now();
    this.onSegment = onSegment;

    this.idleTimer = setInterval(() => {
      const now = Date.now();
      const idleMs = now - this.lastActivity;
      const sessionMs = now - (this.startedAt?.getTime() ?? now);

      if (idleMs >= IDLE_TIMEOUT_MS || sessionMs >= MAX_SESSION_MS) {
        this.onSegment?.();
      }
    }, 10_000); // Check every 10 seconds

    return this.sessionId;
  }

  stop(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    this.sessionId = null;
    this.startedAt = null;
    this.onSegment = null;
  }

  recordActivity(): void {
    this.lastActivity = Date.now();
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getStartedAt(): Date | null {
    return this.startedAt;
  }

  getDurationMs(): number {
    if (!this.startedAt) return 0;
    return Date.now() - this.startedAt.getTime();
  }

  segment(): string {
    // End current session and start a new one
    this.stop();
    return this.start(this.onSegment!);
  }
}
