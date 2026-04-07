import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Detects if any application is currently using the microphone.
 * Platform-specific implementations for Windows, Mac, and Linux.
 */
export async function isMicrophoneInUse(): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      return await isMicInUseWindows();
    } else if (process.platform === "darwin") {
      return await isMicInUseMac();
    } else {
      return await isMicInUseLinux();
    }
  } catch {
    return false;
  }
}

async function isMicInUseWindows(): Promise<boolean> {
  // Check Windows registry for microphone usage
  // When any app uses the mic, Windows sets a "LastUsedTimeStop" = 0 in the registry
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `Get-ChildItem -Path "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone" -Recurse -ErrorAction SilentlyContinue |
     ForEach-Object { Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue } |
     Where-Object { $_.LastUsedTimeStop -eq 0 } |
     Select-Object -First 1 |
     ForEach-Object { Write-Output "ACTIVE" }`,
  ], { timeout: 5000 });
  return stdout.trim() === "ACTIVE";
}

async function isMicInUseMac(): Promise<boolean> {
  // Check if any process is using the microphone via ioreg
  const { stdout } = await execFileAsync("/bin/bash", [
    "-c",
    `log show --predicate 'subsystem == "com.apple.audio" AND category == "HAL"' --last 5s --style compact 2>/dev/null | grep -i "input" | head -1 || ioreg -l | grep -i "IOAudioEngineState" | head -1`,
  ], { timeout: 5000 });

  // Fallback: check if coreaudiod has active input streams
  if (!stdout.trim()) {
    try {
      const { stdout: psOut } = await execFileAsync("/bin/bash", [
        "-c",
        `ps aux | grep -i "coreaudiod\\|audioinput" | grep -v grep | head -1`,
      ], { timeout: 3000 });
      // coreaudiod always runs, so check for actual mic activity via system profiler
      const { stdout: spOut } = await execFileAsync("osascript", [
        "-e",
        `do shell script "fuser /dev/audiotap 2>/dev/null || echo NONE"`,
      ], { timeout: 3000 });
      return spOut.trim() !== "NONE" && spOut.trim() !== "";
    } catch {
      return false;
    }
  }
  return stdout.trim().length > 0;
}

async function isMicInUseLinux(): Promise<boolean> {
  // Check PulseAudio/PipeWire for active source (microphone) streams
  try {
    // Try PipeWire first
    const { stdout } = await execFileAsync("pactl", [
      "list", "source-outputs", "short",
    ], { timeout: 3000 });
    // If there are any source outputs, the mic is in use
    return stdout.trim().length > 0;
  } catch {
    // Fallback: check /proc for processes using audio devices
    try {
      const { stdout } = await execFileAsync("/bin/bash", [
        "-c",
        `fuser /dev/snd/pcmC*D*c 2>/dev/null`,
      ], { timeout: 3000 });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }
}
