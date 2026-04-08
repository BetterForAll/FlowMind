import type { FlowMode } from "../config";

export interface ModePreset {
  transcriptionModel: string;
  detectionModel: string;
  automationModel: string;
  thinking: boolean;
  resolution: { width: number; height: number };
  jpegQuality: number;
  contextLimit: number; // max input tokens for the detection model
}

export const MODE_PRESETS: Record<FlowMode, ModePreset> = {
  economy: {
    transcriptionModel: "gemini-2.5-flash-lite",
    detectionModel: "gemini-2.5-flash-lite",
    automationModel: "gemini-2.5-flash-lite",
    thinking: false,
    resolution: { width: 960, height: 540 },
    jpegQuality: 60,
    contextLimit: 1_000_000,
  },
  standard: {
    transcriptionModel: "gemini-2.5-flash",
    detectionModel: "gemini-2.5-flash",
    automationModel: "gemini-2.5-flash",
    thinking: false,
    resolution: { width: 960, height: 540 },
    jpegQuality: 70,
    contextLimit: 1_000_000,
  },
  pro: {
    transcriptionModel: "gemini-2.5-flash",
    detectionModel: "gemini-2.5-pro",
    automationModel: "gemini-2.5-pro",
    thinking: false,
    resolution: { width: 1280, height: 720 },
    jpegQuality: 75,
    contextLimit: 1_000_000,
  },
  maximum: {
    transcriptionModel: "gemini-2.5-flash",
    detectionModel: "gemini-2.5-pro",
    automationModel: "gemini-2.5-pro",
    thinking: true,
    resolution: { width: 1280, height: 720 },
    jpegQuality: 80,
    contextLimit: 1_000_000,
  },
};

/** Estimated tokens per image at a given resolution */
export function tokensPerImage(resolution: { width: number; height: number }): number {
  if (resolution.width <= 960 && resolution.height <= 540) return 400;
  if (resolution.width <= 1280 && resolution.height <= 720) return 800;
  return 1200;
}

/** Check if a given number of images + text tokens fits in one API call */
export function fitsInOneCall(
  imageCount: number,
  resolution: { width: number; height: number },
  textTokens: number,
  contextLimit: number
): boolean {
  const totalTokens = imageCount * tokensPerImage(resolution) + textTokens;
  return totalTokens < contextLimit * 0.9; // 10% safety margin
}

/** Get the effective settings by merging config overrides with mode preset defaults */
export function getEffectiveSettings(config: {
  mode: FlowMode;
  thinking: boolean;
  transcriptionModel: string | null;
  detectionModel: string | null;
  automationModel: string | null;
  screenshotResolution: { width: number; height: number } | null;
  screenshotQuality: number | null;
}): ModePreset {
  const preset = MODE_PRESETS[config.mode];
  return {
    transcriptionModel: config.transcriptionModel ?? preset.transcriptionModel,
    detectionModel: config.detectionModel ?? preset.detectionModel,
    automationModel: config.automationModel ?? preset.automationModel,
    thinking: config.thinking ?? preset.thinking,
    resolution: config.screenshotResolution ?? preset.resolution,
    jpegQuality: config.screenshotQuality ?? preset.jpegQuality,
    contextLimit: preset.contextLimit,
  };
}
