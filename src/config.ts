import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const CONFIG_PATH = path.join(os.homedir(), "flowmind-data", "config.json");

export interface AppConfig {
  cleanupMode: "immediate" | "1h" | "12h" | "24h" | "7d";
  detectionIntervalMinutes: number;
  audioAutoDetect: boolean;
}

const DEFAULTS: AppConfig = {
  cleanupMode: "immediate",
  detectionIntervalMinutes: 60,
  audioAutoDetect: true,
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
    case "immediate": return 0;
    case "1h": return 60 * 60 * 1000;
    case "12h": return 12 * 60 * 60 * 1000;
    case "24h": return 24 * 60 * 60 * 1000;
    case "7d": return 7 * 24 * 60 * 60 * 1000;
  }
}
