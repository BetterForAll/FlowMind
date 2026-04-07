import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CaptureEvent } from "../types";

const execFileAsync = promisify(execFile);

const DENY_PATTERNS = [
  /1password/i, /keepass/i, /signal/i,
  /incognito/i, /private/i, /\bbank\b/i, /password/i,
];

// Cross-platform active window detection without native dependencies
async function getActiveWindow(): Promise<{ app: string; title: string; pid: number } | null> {
  try {
    if (process.platform === "win32") {
      // PowerShell to get active window info
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinAPI {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$hwnd = [WinAPI]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[WinAPI]::GetWindowText($hwnd, $sb, 256) | Out-Null
$title = $sb.ToString()
$pid = 0
[WinAPI]::GetWindowThreadProcessId($hwnd, [ref]$pid) | Out-Null
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
$name = if ($proc) { $proc.ProcessName } else { "Unknown" }
Write-Output "$name|||$title|||$pid"`,
      ], { timeout: 3000 });
      const [app, title, pid] = stdout.trim().split("|||");
      return { app: app || "Unknown", title: title || "", pid: parseInt(pid) || 0 };
    } else if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("osascript", [
        "-e", `tell application "System Events"
          set frontApp to name of first application process whose frontmost is true
          set frontPID to unix id of first application process whose frontmost is true
        end tell
        tell application frontApp to set winTitle to name of front window
        return frontApp & "|||" & winTitle & "|||" & frontPID`,
      ], { timeout: 3000 });
      const [app, title, pid] = stdout.trim().split("|||");
      return { app: app || "Unknown", title: title || "", pid: parseInt(pid) || 0 };
    } else {
      // Linux — use xdotool
      const { stdout: pidOut } = await execFileAsync("xdotool", ["getactivewindow", "getwindowpid"], { timeout: 3000 });
      const { stdout: nameOut } = await execFileAsync("xdotool", ["getactivewindow", "getwindowclassname"], { timeout: 3000 });
      const { stdout: titleOut } = await execFileAsync("xdotool", ["getactivewindow", "getwindowname"], { timeout: 3000 });
      return { app: nameOut.trim(), title: titleOut.trim(), pid: parseInt(pidOut.trim()) || 0 };
    }
  } catch {
    return null;
  }
}

export class WindowTracker extends EventEmitter {
  private running = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastApp = "";
  private lastTitle = "";

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.interval = setInterval(async () => {
      try {
        const win = await getActiveWindow();
        if (!win) return;

        // Skip if nothing changed
        if (win.app === this.lastApp && win.title === this.lastTitle) return;

        // Skip denied windows
        const combined = `${win.app} ${win.title}`;
        if (DENY_PATTERNS.some((p) => p.test(combined))) return;

        this.lastApp = win.app;
        this.lastTitle = win.title;

        const event: CaptureEvent = {
          ts: new Date().toISOString(),
          type: "window-change",
          data: { app: win.app, title: win.title, pid: win.pid },
        };
        this.emit("event", event);
      } catch {
        // Silently skip
      }
    }, 2000); // Poll every 2 seconds (slightly slower due to process spawning)
  }

  stop(): void {
    if (!this.running) return;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.running = false;
    this.lastApp = "";
    this.lastTitle = "";
  }

  isRunning(): boolean {
    return this.running;
  }
}
