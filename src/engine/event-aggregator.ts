import type { CaptureEvent } from "../types";

// Common keyboard shortcut keycodes (uiohook-napi)
const SHORTCUT_NAMES: Record<string, string> = {
  "ctrl+46": "copy",       // Ctrl+C
  "ctrl+47": "paste",      // Ctrl+V
  "ctrl+45": "cut",        // Ctrl+X
  "ctrl+44": "undo",       // Ctrl+Z
  "ctrl+21": "redo",       // Ctrl+Y
  "ctrl+31": "save",       // Ctrl+S
  "ctrl+30": "select-all", // Ctrl+A
  "ctrl+34": "find",       // Ctrl+F
  "ctrl+33": "open",       // Ctrl+O
  "ctrl+49": "new",        // Ctrl+N
  "ctrl+20": "tab",        // Ctrl+T
  "ctrl+17": "close-tab",  // Ctrl+W
};

interface AppSegment {
  app: string;
  title: string;
  startTime: string;
  endTime: string;
  keypresses: number;
  clicks: number;
  scrolls: number;
  shortcuts: Map<string, number>;
}

/**
 * Aggregate raw capture events into human-readable summaries.
 * Groups events by active application window, counts actions,
 * and recognizes keyboard shortcuts.
 */
export function aggregateEvents(events: CaptureEvent[]): string {
  const relevant = events.filter(
    (e) => e.type !== "session-start" && e.type !== "session-end" && e.type !== "screenshot"
  );

  if (relevant.length === 0) return "(no activity)";

  const segments: AppSegment[] = [];
  let current: AppSegment | null = null;

  for (const event of relevant) {
    if (event.type === "window-change") {
      // Start a new segment
      if (current) segments.push(current);
      current = {
        app: String(event.data.app ?? "Unknown"),
        title: String(event.data.title ?? ""),
        startTime: event.ts,
        endTime: event.ts,
        keypresses: 0,
        clicks: 0,
        scrolls: 0,
        shortcuts: new Map(),
      };
      continue;
    }

    // If no window-change yet, create a default segment
    if (!current) {
      current = {
        app: "Unknown",
        title: "",
        startTime: event.ts,
        endTime: event.ts,
        keypresses: 0,
        clicks: 0,
        scrolls: 0,
        shortcuts: new Map(),
      };
    }

    current.endTime = event.ts;

    switch (event.type) {
      case "keypress": {
        current.keypresses++;
        // Detect shortcuts
        const keycode = event.data.keycode as number;
        const ctrl = event.data.ctrl as boolean;
        const alt = event.data.alt as boolean;
        const meta = event.data.meta as boolean;

        if (ctrl || alt || meta) {
          const prefix = [
            ctrl ? "ctrl" : "",
            alt ? "alt" : "",
            meta ? "meta" : "",
          ].filter(Boolean).join("+");
          const combo = `${prefix}+${keycode}`;
          const name = SHORTCUT_NAMES[combo] ?? combo;
          current.shortcuts.set(name, (current.shortcuts.get(name) ?? 0) + 1);
        }
        break;
      }
      case "click":
        current.clicks++;
        break;
      case "scroll":
        current.scrolls++;
        break;
    }
  }

  if (current) segments.push(current);

  // Merge consecutive segments with same app (can happen if events arrive between window-changes)
  const merged = mergeConsecutiveSegments(segments);

  // Format output
  return merged.map(formatSegment).join("\n");
}

function mergeConsecutiveSegments(segments: AppSegment[]): AppSegment[] {
  if (segments.length === 0) return [];

  const result: AppSegment[] = [segments[0]];

  for (let i = 1; i < segments.length; i++) {
    const prev = result[result.length - 1];
    const curr = segments[i];

    if (prev.app === curr.app && prev.title === curr.title) {
      // Merge into previous
      prev.endTime = curr.endTime;
      prev.keypresses += curr.keypresses;
      prev.clicks += curr.clicks;
      prev.scrolls += curr.scrolls;
      for (const [key, count] of curr.shortcuts) {
        prev.shortcuts.set(key, (prev.shortcuts.get(key) ?? 0) + count);
      }
    } else {
      result.push(curr);
    }
  }

  return result;
}

function formatSegment(seg: AppSegment): string {
  const start = formatTime(seg.startTime);
  const end = formatTime(seg.endTime);
  const timeRange = start === end ? start : `${start}-${end}`;

  // Truncate long titles
  const title = seg.title.length > 60 ? seg.title.slice(0, 57) + "..." : seg.title;

  const parts: string[] = [];
  if (seg.keypresses > 0) parts.push(`${seg.keypresses} keys`);
  if (seg.clicks > 0) parts.push(`${seg.clicks} clicks`);
  if (seg.scrolls > 0) parts.push(`${seg.scrolls} scrolls`);

  // Add shortcuts
  const shortcutStr = Array.from(seg.shortcuts.entries())
    .map(([name, count]) => `${name} ×${count}`)
    .join(", ");
  if (shortcutStr) parts.push(shortcutStr);

  const activity = parts.length > 0 ? parts.join(", ") : "idle";

  return `${timeRange}: [${seg.app}] "${title}" — ${activity}`;
}

function formatTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toTimeString().slice(0, 5); // "HH:MM"
  } catch {
    return isoString;
  }
}
