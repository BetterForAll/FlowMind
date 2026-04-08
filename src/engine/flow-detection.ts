import { GoogleGenAI } from "@google/genai";
import { v4 as uuid } from "uuid";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { FlowStore } from "./flow-store";
import { AudioTranscriber } from "./audio-transcription";
import { aggregateEvents } from "./event-aggregator";
import { CaptureStorage } from "../capture/storage";
import { loadConfig } from "../config";
import { getEffectiveSettings, tokensPerImage, fitsInOneCall } from "../ai/mode-presets";
import type {
  DetectionResult,
  FlowFrontmatter,
  KnowledgeFrontmatter,
  CaptureEvent,
} from "../types";

const DETECTION_PROMPT = `You are FlowMind, an AI that analyzes screen activity data to detect repeated workflows, behavioral patterns, and decision-making knowledge.

Analyze the following user activity timeline and produce a JSON response with detected flows and knowledge.

CLASSIFICATION CRITERIA — follow these strictly:

COMPLETE FLOW — ALL of these must be true:
- A multi-step sequence (3+ distinct, meaningful steps) with a clear beginning and end
- Steps have enough detail to be reproduced by someone else
- Decision logic is observable (not guessed or hedged with "potentially"/"might")
- The flow involves purposeful work, not just opening/closing apps or browsing

PARTIAL FLOW — use when:
- You see a meaningful multi-step sequence but some steps are unclear or missing
- You can identify gaps that need clarification from the user
- Mark gaps with [GAP] and provide specific questions to fill them

KNOWLEDGE FRAGMENT — use for everything else:
- Single observations, habits, preferences, tool usage patterns
- Simple actions like "user opened app X" or "user watched a video"
- Behavioral patterns that are not actionable workflows
- One-time activities or browsing/exploration behavior

IMPORTANT:
- Do NOT mark a flow as "complete" if you are guessing or hedging any steps
- A single activity (watching a video, checking email) is a knowledge fragment, NOT a flow
- Be SPECIFIC — reference actual app names, window titles, and actions observed
- Never include sensitive data (passwords, tokens, personal message content)
- When audio transcript is available, use it to understand VERBAL context: conversations, spoken explanations, voice commands, meetings, video calls
- Correlate spoken context with visual activity
- If the activity is mostly idle or has no meaningful patterns, return empty arrays

Respond with ONLY valid JSON in this exact format:
{
  "complete_flows": [
    {
      "name": "Human-readable flow name",
      "confidence": "high" | "medium",
      "avg_duration_minutes": number,
      "trigger": "what starts this flow",
      "apps": ["app1", "app2"],
      "steps": "Full markdown steps section (use IF/ELSE, FOR EACH where appropriate)",
      "decision_logic": "Markdown section describing decision conditions",
      "tools_and_data": "Markdown section describing tool usage",
      "automation_classification": "Markdown section classifying step types",
      "variations": "Markdown section noting variations"
    }
  ],
  "partial_flows": [
    {
      "name": "Human-readable flow name",
      "confidence": "low" | "medium",
      "apps": ["app1"],
      "observed_steps": "Markdown with observed steps, [GAP] markers",
      "questions": ["Q1: specific question", "Q2: specific question"],
      "best_guess": "What you think the complete flow looks like"
    }
  ],
  "knowledge": [
    {
      "title": "Observation title",
      "category": "decision-pattern" | "habit" | "preference" | "tool-usage",
      "apps": ["app1"],
      "observation": "What was observed",
      "significance": "Why this matters for automation",
      "related_flows": ["flow name if related"]
    }
  ]
}`;

export class FlowDetectionEngine {
  private store: FlowStore;
  private genai: GoogleGenAI;
  private transcriber: AudioTranscriber;
  private running = false;

  constructor(store: FlowStore) {
    this.store = store;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    this.genai = new GoogleGenAI({ apiKey });
    this.transcriber = new AudioTranscriber(this.genai);
  }

  isRunning(): boolean {
    return this.running;
  }

  async detectFlows(): Promise<DetectionResult> {
    if (this.running) {
      throw new Error("Detection already in progress");
    }

    this.running = true;
    try {
      const config = await loadConfig();
      const settings = getEffectiveSettings(config);

      // 1. Gather data from recent sessions (based on analysis interval)
      const intervalMs = config.detectionIntervalMinutes * 60 * 1000;
      const since = new Date(Date.now() - intervalMs);
      const sessionDirs = await CaptureStorage.getRecentSessionDirs(since);

      const emptyResult: DetectionResult = {
        newComplete: 0, updatedComplete: 0, newPartial: 0, newKnowledge: 0, filesWritten: [],
      };

      if (sessionDirs.length === 0) return emptyResult;

      // 2. Load and aggregate events
      const events = await this.loadEvents(sessionDirs);
      if (events.length === 0) return emptyResult;
      const timeline = aggregateEvents(events);
      console.log(`[Detection] Aggregated ${events.length} events into ${timeline.split("\n").length} lines`);

      // 3. Transcribe audio files
      const transcript = await this.transcriber.transcribeSessions(sessionDirs, settings.transcriptionModel);

      // 4. Load ALL screenshots
      const screenshots = await this.loadAllScreenshots(sessionDirs);
      console.log(`[Detection] Loaded ${screenshots.length} screenshots`);

      // 5. Analyze — chunk if needed
      const textTokens = (timeline.length + (transcript?.length ?? 0) + DETECTION_PROMPT.length) / 4; // rough estimate
      const analysis = fitsInOneCall(screenshots.length, settings.resolution, textTokens, settings.contextLimit)
        ? await this.analyzeWithGemini(settings, timeline, screenshots, transcript)
        : await this.analyzeChunked(settings, timeline, screenshots, transcript);

      // 6. Save results
      const result = await this.saveResults(analysis);

      // 7. Mark sessions as analyzed
      await CaptureStorage.markAnalyzed(sessionDirs);

      return result;
    } finally {
      this.running = false;
    }
  }

  private async loadEvents(sessionDirs: string[]): Promise<CaptureEvent[]> {
    const allEvents: CaptureEvent[] = [];
    for (const dir of sessionDirs) {
      const eventsFile = path.join(dir, "events.jsonl");
      if (!fs.existsSync(eventsFile)) continue;
      const content = await fsp.readFile(eventsFile, "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          allEvents.push(JSON.parse(line) as CaptureEvent);
        } catch { /* skip malformed lines */ }
      }
    }
    return allEvents.sort(
      (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
    );
  }

  private async loadAllScreenshots(
    sessionDirs: string[]
  ): Promise<{ ts: string; base64: string; time: number }[]> {
    const screenshots: { ts: string; base64: string; time: number }[] = [];
    for (const dir of sessionDirs) {
      const ssDir = path.join(dir, "screenshots");
      if (!fs.existsSync(ssDir)) continue;
      const files = await fsp.readdir(ssDir);
      for (const file of files) {
        if (!file.endsWith(".jpg")) continue;
        const time = parseInt(file.replace(".jpg", ""), 10);
        if (isNaN(time)) continue;
        const filePath = path.join(ssDir, file);
        const buffer = await fsp.readFile(filePath);
        screenshots.push({
          ts: new Date(time).toISOString(),
          base64: buffer.toString("base64"),
          time,
        });
      }
    }
    screenshots.sort((a, b) => a.time - b.time);
    return screenshots;
  }

  private async analyzeWithGemini(
    settings: import("../ai/mode-presets").ModePreset,
    timeline: string,
    screenshots: { ts: string; base64: string }[],
    transcript?: string
  ): Promise<GeminiAnalysis> {
    const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [
      { text: DETECTION_PROMPT },
      { text: `\n\n## Activity Timeline\n\n${timeline}` },
    ];

    if (transcript) {
      parts.push({
        text: `\n\n## Audio Transcript\n\nThe following is a transcript of audio captured during this session (system audio + microphone). Use this to understand verbal context — conversations, explanations, voice commands, meetings, video calls, etc.\n\n${transcript}`,
      });
    }

    if (screenshots.length > 0) {
      parts.push({ text: `\n\n## Screenshots (${screenshots.length} captured during this session)\n` });
      for (const ss of screenshots) {
        parts.push({ text: `\n### Screenshot at ${ss.ts}\n` });
        parts.push({
          inlineData: { mimeType: "image/jpeg", data: ss.base64 },
        });
      }
    }

    console.log(`[Detection] Sending ${screenshots.length} screenshots to ${settings.detectionModel}${settings.thinking ? " (thinking)" : ""}`);

    const response = await this.genai.models.generateContent({
      model: settings.detectionModel,
      contents: [{ role: "user", parts }],
      config: {
        responseMimeType: "application/json",
        ...(settings.thinking ? { thinkingConfig: { thinkingBudget: 8192 } } : {}),
      },
    });

    let text = response.text ?? "";
    text = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    text = text.replace(/[\x00-\x1f\x7f]/g, (ch) =>
      ch === "\n" || ch === "\r" || ch === "\t" ? ch : ""
    );
    return JSON.parse(text) as GeminiAnalysis;
  }

  /** Split data into chunks that fit the model's context, analyze each, then synthesize */
  private async analyzeChunked(
    settings: import("../ai/mode-presets").ModePreset,
    timeline: string,
    screenshots: { ts: string; base64: string; time: number }[],
    transcript?: string
  ): Promise<GeminiAnalysis> {
    const tpi = tokensPerImage(settings.resolution);
    const textTokens = (timeline.length + (transcript?.length ?? 0) + DETECTION_PROMPT.length) / 4;
    const maxImagesPerChunk = Math.floor((settings.contextLimit * 0.85 - textTokens) / tpi);
    const chunkCount = Math.ceil(screenshots.length / maxImagesPerChunk);

    console.log(`[Detection] Chunking: ${screenshots.length} screenshots into ${chunkCount} chunks (max ${maxImagesPerChunk} images/chunk)`);

    // Split timeline by time ranges matching screenshot chunks
    const chunkResults: GeminiAnalysis[] = [];

    for (let i = 0; i < chunkCount; i++) {
      const chunkScreenshots = screenshots.slice(i * maxImagesPerChunk, (i + 1) * maxImagesPerChunk);
      console.log(`[Detection] Analyzing chunk ${i + 1}/${chunkCount} (${chunkScreenshots.length} screenshots)`);

      const result = await this.analyzeWithGemini(
        settings,
        timeline, // full timeline is small after aggregation
        chunkScreenshots,
        transcript // full transcript is small
      );
      chunkResults.push(result);
    }

    // Synthesis pass: merge chunk results
    if (chunkResults.length === 1) return chunkResults[0];

    console.log(`[Detection] Synthesis pass: merging ${chunkResults.length} chunk results`);
    return this.synthesizeChunks(settings, chunkResults);
  }

  private async synthesizeChunks(
    settings: import("../ai/mode-presets").ModePreset,
    chunks: GeminiAnalysis[]
  ): Promise<GeminiAnalysis> {
    const synthesisPrompt = `You are FlowMind. You received multiple analysis chunks from the same session. Merge and deduplicate them into a single coherent result.

Rules:
- If the same flow appears in multiple chunks, merge into one with combined details
- Remove duplicates in knowledge fragments
- Maintain the same JSON output format
- Prefer higher-confidence classifications when merging

Here are the chunk results:

${chunks.map((c, i) => `### Chunk ${i + 1}\n${JSON.stringify(c, null, 2)}`).join("\n\n")}

Respond with ONLY the merged JSON.`;

    const response = await this.genai.models.generateContent({
      model: settings.detectionModel,
      contents: [{ role: "user", parts: [{ text: synthesisPrompt }] }],
      config: {
        responseMimeType: "application/json",
        ...(settings.thinking ? { thinkingConfig: { thinkingBudget: 8192 } } : {}),
      },
    });

    let text = response.text ?? "";
    text = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    text = text.replace(/[\x00-\x1f\x7f]/g, (ch) =>
      ch === "\n" || ch === "\r" || ch === "\t" ? ch : ""
    );
    return JSON.parse(text) as GeminiAnalysis;
  }

  private async saveResults(analysis: GeminiAnalysis): Promise<DetectionResult> {
    const result: DetectionResult = {
      newComplete: 0,
      updatedComplete: 0,
      newPartial: 0,
      newKnowledge: 0,
      filesWritten: [],
    };

    const now = new Date().toISOString();

    // Save complete flows
    for (const flow of analysis.complete_flows ?? []) {
      const frontmatter: FlowFrontmatter = {
        type: "complete-flow",
        id: `flow-${uuid()}`,
        name: flow.name,
        detected: now,
        last_seen: now,
        occurrences: 1,
        confidence: flow.confidence as "high" | "medium",
        avg_duration: flow.avg_duration_minutes,
        trigger: flow.trigger,
        apps: flow.apps,
      };

      const body = `# ${flow.name}

## Trigger
${flow.trigger}

## Steps
${flow.steps}

## Decision Logic
${flow.decision_logic}

## Tools & Data Sources
${flow.tools_and_data}

## Automation Classification
${flow.automation_classification}

## Variations Observed
${flow.variations}`;

      const filePath = await this.store.saveFlow("complete", frontmatter, body);
      result.newComplete++;
      result.filesWritten.push(filePath);
    }

    // Save partial flows
    for (const flow of analysis.partial_flows ?? []) {
      const frontmatter: FlowFrontmatter = {
        type: "partial-flow",
        id: `flow-${uuid()}`,
        name: flow.name,
        detected: now,
        last_seen: now,
        occurrences: 1,
        confidence: flow.confidence as "low" | "medium",
        gaps: (flow.observed_steps.match(/\[GAP\]/g) ?? []).length,
        apps: flow.apps,
      };

      const body = `# ${flow.name} (Partial)

## Observed Steps
${flow.observed_steps}

## Questions to Complete This Flow
${flow.questions.map((q, i) => `- Q${i + 1}: ${q}`).join("\n")}

## What I Think Is Happening
${flow.best_guess}`;

      const filePath = await this.store.saveFlow("partial", frontmatter, body);
      result.newPartial++;
      result.filesWritten.push(filePath);
    }

    // Save knowledge fragments
    for (const k of analysis.knowledge ?? []) {
      const frontmatter: KnowledgeFrontmatter = {
        type: "knowledge",
        id: `knowledge-${uuid()}`,
        detected: now,
        category: k.category as KnowledgeFrontmatter["category"],
        apps: k.apps,
      };

      const body = `# ${k.title}

## Observation
${k.observation}

## Potential Significance
${k.significance}

## Related Flows
${k.related_flows.map((r) => `- ${r}`).join("\n") || "- None yet"}`;

      const filePath = await this.store.saveKnowledge(frontmatter, body);
      result.newKnowledge++;
      result.filesWritten.push(filePath);
    }

    // Save run summary
    const summary = `# FlowMind Run — ${now}
- Analyzed: last 60 minutes
- Complete flows detected: ${result.newComplete} (new: ${result.newComplete}, updated: ${result.updatedComplete})
- Partial flows detected: ${result.newPartial}
- Knowledge fragments: ${result.newKnowledge}
- Files written: ${result.filesWritten.map((f) => `\n  - ${f}`).join("")}`;

    await this.store.saveSummary(summary);

    return result;
  }
}

// Internal types for Gemini response
interface GeminiAnalysis {
  complete_flows?: {
    name: string;
    confidence: string;
    avg_duration_minutes: number;
    trigger: string;
    apps: string[];
    steps: string;
    decision_logic: string;
    tools_and_data: string;
    automation_classification: string;
    variations: string;
  }[];
  partial_flows?: {
    name: string;
    confidence: string;
    apps: string[];
    observed_steps: string;
    questions: string[];
    best_guess: string;
  }[];
  knowledge?: {
    title: string;
    category: string;
    apps: string[];
    observation: string;
    significance: string;
    related_flows: string[];
  }[];
}
