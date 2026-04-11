import { GoogleGenAI } from "@google/genai";
import { v4 as uuid } from "uuid";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DescriptionStore } from "./description-store";
import { aggregateEvents } from "./event-aggregator";
import { AudioTranscriber } from "./audio-transcription";
import { loadConfig } from "../config";
import { getEffectiveSettings } from "../ai/mode-presets";
import type { CaptureEvent } from "../types";

const DESCRIBE_PROMPT = `You are FlowMind's observer. Your job is to (a) produce a detailed, factual narrative describing what the user did during a short time window, and (b) identify which screenshots are crucial for later understanding or reproducing what happened.

You will receive:
- Optionally, the narrative from the PREVIOUS window, for context only (do not repeat it)
- A timeline of aggregated input events (keypresses, clicks, scrolls, window changes)
- Screenshots captured during the window (chronological, each labeled with its exact ISO timestamp header)
- Optionally, an audio transcript (speech/meetings during this window)

Respond with ONLY valid JSON in this exact shape:
{
  "narrative": "Markdown narrative (see rules below).",
  "key_screenshots": [
    {
      "timestamp": "ISO timestamp copied EXACTLY from a screenshot header shown above",
      "reason": "One short sentence on why this frame is crucial"
    }
  ]
}

RULES FOR narrative:
- Be SPECIFIC — reference actual app names, window titles, file names, URLs, button labels visible on screen
- Cover which apps were active, what the user read/typed/clicked/navigated, visible content, and any decision signals
- Describe what is visible, not what you guess. If something is unclear, say so rather than invent.
- If a previous-window narrative is provided, continue the story naturally (e.g., "the user continued editing auth.ts") — do NOT repeat the previous window's content
- Do NOT classify this as a flow or pattern — that is a later phase's job. Just describe.
- Do NOT include sensitive data (passwords, tokens, personal message contents). Redact as "[REDACTED]".
- If nothing meaningful happened (idle, empty desktop), say so concisely in one or two sentences.

RULES FOR audio transcript (when present):
- AUDIO RELEVANCE CHECK: Before mentioning anything from the transcript, decide whether it's actually related to the on-screen activity.
  - **Relevant**: the user narrating what they're doing ("I'm going to search for..."), a meeting or call where what's said matches the visible app (Zoom/Teams/Slack call), a video/audio being played on screen whose content matches what's visible, a voice command or dictation that the user acted on.
  - **Irrelevant background noise**: unrelated conversations happening in the room, family members speaking, background TV/music unrelated to the screen, greetings like "good morning" or "hello", phone calls unrelated to the task, pets, children.
- If the audio is relevant: weave it into the narrative where it correlates with visual activity.
- If the audio is irrelevant background noise: **omit it entirely from the narrative**. Do not quote it, do not mention that audio was present, do not describe what was said. Pretend it wasn't there.
- If you are unsure whether audio is relevant, err on the side of omitting it.

RULES FOR key_screenshots:
- Include ONLY frames that capture information essential for reproducing or verifying what happened: unique UI states, decision moments (modals, dropdowns, error dialogs), visible document content, exact button labels clicked, form values, error messages, first views of a new screen
- Be selective. Typical windows have 0 to 3 key screenshots. Rarely more than 5. Idle or repetitive windows should have an empty list.
- Do NOT include a screenshot "just in case" or because it looks nice. The goal is to preserve the minimum visual record needed to reconstruct the activity.
- The timestamp MUST match a screenshot header you were shown, character-for-character. Do not invent timestamps.`;

export class DescribeEngine {
  private store: DescriptionStore;
  private genai: GoogleGenAI;
  private transcriber: AudioTranscriber;

  // Serialized execution queue — every describeWindow call waits for the previous one.
  // This prevents the post-capture flush from skipping while an interval call is mid-flight,
  // which previously caused later windows to be missing when detection ran.
  private queue: Promise<unknown> = Promise.resolve();
  private activeCount = 0;

  // In-memory cache of last described end-time per session (by sessionDir path).
  // On startup this is empty; getLastWindowEnd falls back to disk lookup.
  private lastEndBySession = new Map<string, string>();

  constructor(store: DescriptionStore) {
    this.store = store;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    this.genai = new GoogleGenAI({ apiKey });
    this.transcriber = new AudioTranscriber(this.genai);
  }

  isRunning(): boolean {
    return this.activeCount > 0;
  }

  /** Wait for any in-flight describe calls to fully complete. */
  async waitForIdle(): Promise<void> {
    try { await this.queue; } catch { /* previous failures don't block waiters */ }
  }

  /**
   * Describe the unprocessed portion of `sessionDir` up to `upTo` (default: now).
   * Returns the file path of the written description, or null if nothing new to describe.
   *
   * Calls are serialized: if another describe is in progress, this call queues behind it
   * and runs after it completes. This guarantees that a "final flush" call on capture stop
   * will not be dropped while an interval call is still processing an earlier window.
   */
  async describeWindow(
    sessionDir: string,
    sessionId: string,
    upTo: Date = new Date()
  ): Promise<string | null> {
    this.activeCount++;
    const next = this.queue
      .catch(() => { /* swallow — prior failures shouldn't block this call */ })
      .then(() => this.doDescribeWindow(sessionDir, sessionId, upTo));
    this.queue = next.catch(() => {});
    try {
      return await next;
    } finally {
      this.activeCount--;
    }
  }

  private async doDescribeWindow(
    sessionDir: string,
    sessionId: string,
    upTo: Date
  ): Promise<string | null> {
    try {
      await this.store.ensureDirectory();

      // Determine window start — either cached, or last described on disk, or session start
      let windowStartIso = this.lastEndBySession.get(sessionDir);
      if (!windowStartIso) {
        const fromDisk = await this.store.getLastWindowEnd(sessionId);
        if (fromDisk) windowStartIso = fromDisk;
      }
      if (!windowStartIso) {
        // First window for this session — use earliest event or session dir mtime
        windowStartIso = await this.findSessionStart(sessionDir);
      }

      const windowStart = new Date(windowStartIso);
      const windowEnd = upTo;

      if (windowEnd.getTime() <= windowStart.getTime()) {
        console.log(`[Describe] Empty window, skipping`);
        return null;
      }

      // Load events in [windowStart, windowEnd)
      const events = await this.loadEventsInWindow(sessionDir, windowStart, windowEnd);
      const screenshots = await this.loadScreenshotsInWindow(sessionDir, windowStart, windowEnd);

      if (events.length === 0 && screenshots.length === 0) {
        console.log(`[Describe] No events or screenshots in window — skipping`);
        // Still advance the cursor so we don't re-check the same empty window
        this.lastEndBySession.set(sessionDir, windowEnd.toISOString());
        return null;
      }

      const timeline = aggregateEvents(events);

      // Audio transcription: handle just audio files that landed in this window.
      // The transcriber caches per-file, so this is cheap on re-runs.
      const audioFiles = await this.collectAudioInWindow(sessionDir, windowStart, windowEnd);
      const transcript = audioFiles.length > 0
        ? await this.transcribeAudioFiles(audioFiles)
        : "";

      // Pull the previous window's narrative as context (if one exists for this session)
      const previousNarrative = await this.store.getLastNarrative(sessionId);

      // Call Gemini with multimodal input
      const config = await loadConfig();
      const settings = getEffectiveSettings(config);
      const { narrative, keyScreenshotTimestamps } = await this.callGemini(
        settings.detectionModel,
        timeline,
        screenshots,
        transcript,
        previousNarrative
      );

      // Resolve key-screenshot timestamps back to source files and prepare them for persistence
      const keyScreenshots = this.resolveKeyScreenshots(
        keyScreenshotTimestamps,
        sessionDir
      );

      // Persist description markdown AND copy key screenshots into sibling .keys folder
      const id = `desc-${uuid()}`;
      const filePath = await this.store.saveDescription(
        {
          type: "description",
          id,
          sessionId,
          sessionDir,
          windowStart: windowStart.toISOString(),
          windowEnd: windowEnd.toISOString(),
          eventCount: events.length,
          screenshotCount: screenshots.length,
          analyzed: false,
          linked: false,
        },
        narrative,
        keyScreenshots
      );

      this.lastEndBySession.set(sessionDir, windowEnd.toISOString());
      console.log(
        `[Describe] Wrote ${path.basename(filePath)} — ${events.length} events, ${screenshots.length} screenshots, ${keyScreenshots.length} key frames`
      );
      return filePath;
    } catch (err) {
      console.error(`[Describe] Failed:`, err);
      throw err;
    }
  }

  private async findSessionStart(sessionDir: string): Promise<string> {
    const eventsFile = path.join(sessionDir, "events.jsonl");
    if (fs.existsSync(eventsFile)) {
      const content = await fsp.readFile(eventsFile, "utf-8");
      const firstLine = content.split("\n").find((l) => l.trim());
      if (firstLine) {
        try {
          const parsed = JSON.parse(firstLine) as CaptureEvent;
          return parsed.ts;
        } catch { /* fall through */ }
      }
    }
    // Fallback: directory mtime
    const stat = await fsp.stat(sessionDir).catch(() => null);
    return (stat?.mtime ?? new Date()).toISOString();
  }

  private async loadEventsInWindow(
    sessionDir: string,
    start: Date,
    end: Date
  ): Promise<CaptureEvent[]> {
    const eventsFile = path.join(sessionDir, "events.jsonl");
    if (!fs.existsSync(eventsFile)) return [];

    const content = await fsp.readFile(eventsFile, "utf-8");
    const events: CaptureEvent[] = [];
    const startMs = start.getTime();
    const endMs = end.getTime();

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as CaptureEvent;
        const ts = new Date(ev.ts).getTime();
        if (ts >= startMs && ts < endMs) events.push(ev);
      } catch { /* skip malformed */ }
    }
    return events;
  }

  private async loadScreenshotsInWindow(
    sessionDir: string,
    start: Date,
    end: Date
  ): Promise<{ ts: string; base64: string }[]> {
    const ssDir = path.join(sessionDir, "screenshots");
    if (!fs.existsSync(ssDir)) return [];

    const files = await fsp.readdir(ssDir);
    const startMs = start.getTime();
    const endMs = end.getTime();

    const matching: { time: number; file: string }[] = [];
    for (const f of files) {
      if (!f.endsWith(".jpg")) continue;
      const time = parseInt(f.replace(".jpg", ""), 10);
      if (isNaN(time)) continue;
      if (time >= startMs && time < endMs) matching.push({ time, file: f });
    }
    matching.sort((a, b) => a.time - b.time);

    const result: { ts: string; base64: string }[] = [];
    for (const { time, file } of matching) {
      const buf = await fsp.readFile(path.join(ssDir, file));
      result.push({
        ts: new Date(time).toISOString(),
        base64: buf.toString("base64"),
      });
    }
    return result;
  }

  private async collectAudioInWindow(
    sessionDir: string,
    start: Date,
    end: Date
  ): Promise<string[]> {
    const audioDir = path.join(sessionDir, "audio");
    if (!fs.existsSync(audioDir)) return [];

    const files = await fsp.readdir(audioDir);
    const startMs = start.getTime();
    const endMs = end.getTime();
    const matching: string[] = [];

    for (const f of files) {
      if (!f.endsWith(".webm")) continue;
      // Filename formats: "recording-<ms>.webm" or "chunk-NNN.webm"
      const tsMatch = f.match(/(\d{10,})/);
      if (!tsMatch) {
        // chunk-NNN — no timestamp, include it unconditionally (unlikely with new capture)
        matching.push(path.join(audioDir, f));
        continue;
      }
      const time = parseInt(tsMatch[1], 10);
      if (time >= startMs && time < endMs) {
        matching.push(path.join(audioDir, f));
      }
    }
    return matching;
  }

  private async transcribeAudioFiles(filePaths: string[]): Promise<string> {
    // The AudioTranscriber operates on session dirs. We want a subset of files,
    // so we construct a temporary "virtual session dir" view by grouping paths
    // under their parent session. In practice all files share a single audioDir,
    // so we just hand the transcriber the shared parent's parent.
    if (filePaths.length === 0) return "";
    const parents = new Set(filePaths.map((f) => path.dirname(path.dirname(f))));
    const sessionDirs = Array.from(parents);

    // transcribeSessions iterates ALL audio in each session dir. That's more than
    // we want for a 1-minute window — but because of per-file caching, repeated
    // calls are cheap. To avoid transcribing future-window files we'd need to
    // filter inside the transcriber; for now, accept the cached-file cost.
    const config = await loadConfig();
    const settings = getEffectiveSettings(config);
    return this.transcriber.transcribeSessions(sessionDirs, settings.transcriptionModel);
  }

  private async callGemini(
    model: string,
    timeline: string,
    screenshots: { ts: string; base64: string }[],
    transcript: string,
    previousNarrative: string | null
  ): Promise<{ narrative: string; keyScreenshotTimestamps: string[] }> {
    const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [
      { text: DESCRIBE_PROMPT },
    ];

    if (previousNarrative) {
      parts.push({
        text: `\n\n## Previous Window Narrative (context only — do not repeat)\n\n${previousNarrative}`,
      });
    }

    parts.push({
      text: `\n\n## Activity Timeline\n\n${timeline || "(no input events)"}`,
    });

    if (transcript) {
      parts.push({
        text: `\n\n## Audio Transcript\n\n${transcript}`,
      });
    }

    if (screenshots.length > 0) {
      parts.push({ text: `\n\n## Screenshots (${screenshots.length} captured, chronological)\n` });
      for (const ss of screenshots) {
        parts.push({ text: `\n### ${ss.ts}\n` });
        parts.push({
          inlineData: { mimeType: "image/jpeg", data: ss.base64 },
        });
      }
    }

    console.log(`[Describe] Sending ${screenshots.length} screenshots to ${model}`);

    const apiCall = this.genai.models.generateContent({
      model,
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json" },
    });

    const response = await Promise.race([
      apiCall,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Gemini describe timed out after 120s`)),
          120_000
        )
      ),
    ]);

    let text = (response.text ?? "").trim();
    text = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    text = text.replace(/[\x00-\x1f\x7f]/g, (ch) =>
      ch === "\n" || ch === "\r" || ch === "\t" ? ch : ""
    );

    let parsed: { narrative?: string; key_screenshots?: { timestamp: string; reason?: string }[] };
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      // Fall back gracefully — treat the whole response as a narrative with no key frames
      console.warn(`[Describe] JSON parse failed, using raw text as narrative`);
      return { narrative: text, keyScreenshotTimestamps: [] };
    }

    const narrative = (parsed.narrative ?? "").trim() || "(empty narrative)";
    const keyScreenshotTimestamps = (parsed.key_screenshots ?? [])
      .map((k) => (k.timestamp ?? "").trim())
      .filter((t) => t.length > 0);

    return { narrative, keyScreenshotTimestamps };
  }

  /** Resolve ISO timestamps returned by the model back to actual .jpg paths in the session. */
  private resolveKeyScreenshots(
    timestamps: string[],
    sessionDir: string
  ): { sourcePath: string; ts: string }[] {
    const ssDir = path.join(sessionDir, "screenshots");
    if (!fs.existsSync(ssDir)) return [];

    const resolved: { sourcePath: string; ts: string }[] = [];
    const seen = new Set<string>();

    for (const ts of timestamps) {
      const ms = new Date(ts).getTime();
      if (isNaN(ms)) continue;
      if (seen.has(String(ms))) continue;
      const filePath = path.join(ssDir, `${ms}.jpg`);
      if (!fs.existsSync(filePath)) {
        // Model may have hallucinated or rounded the timestamp — skip it
        continue;
      }
      resolved.push({ sourcePath: filePath, ts });
      seen.add(String(ms));
    }

    return resolved;
  }
}
