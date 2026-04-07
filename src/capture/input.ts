import { uIOhook } from "uiohook-napi";
import { EventEmitter } from "node:events";
import type { CaptureEvent } from "../types";

// Keycodes worth tracking — not every character, just meaningful actions
// Using raw keycodes since UiohookKey enum may not cover all
const MEANINGFUL_KEYCODES = new Set([
  28,   // Enter
  15,   // Tab
  1,    // Escape
  14,   // Backspace
  3667, // Delete
  59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88, // F1-F12
]);

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
      // Track meaningful keys, or any key with Ctrl/Alt/Meta modifier
      const hasModifier = e.ctrlKey || e.altKey || e.metaKey;
      if (!MEANINGFUL_KEYCODES.has(e.keycode) && !hasModifier) return;

      const event: CaptureEvent = {
        ts: new Date().toISOString(),
        type: "keypress",
        data: {
          keycode: e.keycode,
          ctrl: e.ctrlKey || false,
          alt: e.altKey || false,
          meta: e.metaKey || false,
          shift: e.shiftKey || false,
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
