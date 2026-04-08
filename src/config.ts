import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const CONFIG_PATH = path.join(os.homedir(), "flowmind-data", "config.json");

export type FlowMode = "economy" | "standard" | "pro" | "maximum";

export interface AppConfig {
  mode: FlowMode;
  cleanupMode: "after-analysis" | "1h" | "4h" | "manual";
  detectionIntervalMinutes: number;
  screenshotIntervalMs: number;
  thinking: boolean;
  showRawData: boolean;
  // Per-mode model overrides (null = use preset default)
  transcriptionModel: string | null;
  detectionModel: string | null;
  automationModel: string | null;
  // Resolution & quality overrides (null = use preset default)
  screenshotResolution: { width: number; height: number } | null;
  screenshotQuality: number | null;
  // API key (optional — falls back to GEMINI_API_KEY env var)
  geminiApiKey: string | null;
}

const DEFAULTS: AppConfig = {
  mode: "standard",
  cleanupMode: "after-analysis",
  detectionIntervalMinutes: 15,
  screenshotIntervalMs: 2000,
  thinking: false,
  showRawData: true,
  transcriptionModel: null,
  detectionModel: null,
  automationModel: null,
  screenshotResolution: null,
  screenshotQuality: null,
  geminiApiKey: null,
};

let cachedConfig: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (cachedConfig) return cachedConfig;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = await fsp.readFile(CONFIG_PATH, "utf-8");
      cachedConfig = { ...DEFAULTS, ...JSON.parse(raw) };
      return cachedConfig!;
    }
  } catch { /* use defaults */ }
  cachedConfig = { ...DEFAULTS };
  return cachedConfig;
}

export async function saveConfig(config: Partial<AppConfig>): Promise<AppConfig> {
  const current = await loadConfig();
  const updated = { ...current, ...config };
  const dir = path.dirname(CONFIG_PATH);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(updated, null, 2), "utf-8");
  cachedConfig = updated;
  return updated;
}

export function cleanupModeToMs(mode: AppConfig["cleanupMode"]): number {
  switch (mode) {
    case "after-analysis": return 0;
    case "1h": return 60 * 60 * 1000;
    case "4h": return 4 * 60 * 60 * 1000;
    case "manual": return Infinity;
  }
}
