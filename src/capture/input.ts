import { uIOhook } from "uiohook-napi";
import { EventEmitter } from "node:events";
import type { CaptureEvent } from "../types";

export class InputCapture extends EventEmitter {
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;

    uIOhook.on("click", (e) => {
      const event: CaptureEvent = {
        ts: new Date().toISOString(),
        type: "click",
        data: { x: e.x, y: e.y, button: e.button },
      };
      this.emit("event", event);
    });

    uIOhook.on("keydown", (e) => {
      // Capture EVERY keypress so phase 1 can describe typed content.
      // If `keychar` is a printable character, include it so downstream
      // aggregation can reconstruct what the user actually typed.
      const keychar = (e as unknown as { keychar?: number }).keychar ?? 0;
      const char = keychar >= 32 && keychar !== 127 ? String.fromCharCode(keychar) : undefined;

      const event: CaptureEvent = {
        ts: new Date().toISOString(),
        type: "keypress",
        data: {
          keycode: e.keycode,
          ctrl: e.ctrlKey || false,
          alt: e.altKey || false,
          meta: e.metaKey || false,
          shift: e.shiftKey || false,
          ...(char !== undefined ? { char } : {}),
        },
      };
      this.emit("event", event);
    });

    uIOhook.on("wheel", (e) => {
      const event: CaptureEvent = {
        ts: new Date().toISOString(),
        type: "scroll",
        data: { x: e.x, y: e.y, direction: e.direction, rotation: e.rotation },
      };
      this.emit("event", event);
    });

    uIOhook.start();
  }

  stop(): void {
    if (!this.running) return;
    uIOhook.stop();
    uIOhook.removeAllListeners();
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }
}
