/**
 * Mic activity detection via audio level monitoring.
 *
 * This runs in the RENDERER process (needs Web Audio API).
 * The renderer polls the mic level and sends it to main process.
 * Main process decides when to start/stop recording based on levels.
 */

// Threshold for "mic is active" — 0 to 1 scale
// Typical speech is 0.05-0.3, silence is < 0.01
const ACTIVITY_THRESHOLD = 0.02;

export function isMicActive(level: number): boolean {
  return level > ACTIVITY_THRESHOLD;
}
