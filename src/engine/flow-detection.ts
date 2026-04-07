import { GoogleGenAI } from "@google/genai";
import { v4 as uuid } from "uuid";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { FlowStore } from "./flow-store";
import { CaptureStorage } from "../capture/storage";
import type {
  DetectionResult,
  FlowFrontmatter,
  KnowledgeFrontmatter,
  CaptureEvent,
} from "../types";

const DETECTION_PROMPT = `You are FlowMind, an AI that analyzes screen activity data to detect repeated workflows, behavioral patterns, and decision-making knowledge.

Analyze the following user activity timeline and produce a JSON response with detected flows and knowledge.

RULES:
- Be SPECIFIC — reference actual app names, window titles, and actions observed
- Identify sequences of actions that form coherent workflows
- Look for conditional behavior, loops, and decision points
- Never include sensitive data (passwords, tokens, personal message content)
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
  private running = false;

  constructor(store: FlowStore) {
    this.store = store;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    this.genai = new GoogleGenAI({ apiKey });
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
      // 1. Gather data from local capture sessions
      const since = new Date(Date.now() - 60 * 60 * 1000);
      const sessionDirs = await CaptureStorage.getRecentSessionDirs(since);

      if (sessionDirs.length === 0) {
        return {
          newComplete: 0,
          updatedComplete: 0,
          newPartial: 0,
          newKnowledge: 0,
          filesWritten: [],
        };
      }

      // 2. Build activity timeline from JSONL events
      const events = await this.loadEvents(sessionDirs);
      if (events.length === 0) {
        return {
          newComplete: 0,
          updatedComplete: 0,
          newPartial: 0,
          newKnowledge: 0,
          filesWritten: [],
        };
      }

      const timeline = this.buildTimeline(events);

      // 3. Collect screenshots for multimodal analysis (max 20)
      const screenshots = await this.loadScreenshots(sessionDirs, 20);

      // 4. Send to Gemini for analysis
      const analysis = await this.analyzeWithGemini(timeline, screenshots);

      // 5. Save results
      const result = await this.saveResults(analysis);

      // 6. Mark sessions as analyzed
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

  private async loadScreenshots(
    sessionDirs: string[],
    max: number
  ): Promise<{ ts: string; base64: string }[]> {
    const screenshots: { ts: string; base64: string; time: number }[] = [];
    for (const dir of sessionDirs) {
      const ssDir = path.join(dir, "screenshots");
      if (!fs.existsSync(ssDir)) continue;
      const files = await fsp.readdir(ssDir);
      for (const file of files) {
        if (!file.endsWith(".jpg")) continue;
        const ts = parseInt(file.replace(".jpg", ""), 10);
        if (isNaN(ts)) continue;
        screenshots.push({
          ts: new Date(ts).toISOString(),
          base64: "", // placeholder
          time: ts,
        });
      }
    }

    // Select evenly spaced screenshots
    screenshots.sort((a, b) => a.time - b.time);
    const step = Math.max(1, Math.floor(screenshots.length / max));
    const selected = screenshots.filter((_, i) => i % step === 0).slice(0, max);

    // Load actual data for selected screenshots
    for (const ss of selected) {
      for (const dir of sessionDirs) {
        const filePath = path.join(dir, "screenshots", `${ss.time}.jpg`);
        if (fs.existsSync(filePath)) {
          const buffer = await fsp.readFile(filePath);
          ss.base64 = buffer.toString("base64");
          break;
        }
      }
    }

    return selected.filter((s) => s.base64).map(({ ts, base64 }) => ({ ts, base64 }));
  }

  private buildTimeline(events: CaptureEvent[]): string {
    return events
      .filter((e) => e.type !== "session-start" && e.type !== "session-end" && e.type !== "screenshot")
      .map((e) => {
        switch (e.type) {
          case "window-change":
            return `${e.ts}: [${e.data.app}] "${e.data.title}"`;
          case "click":
            return `${e.ts}: Click at (${e.data.x}, ${e.data.y}) button=${e.data.button}`;
          case "keypress":
            return `${e.ts}: Keypress code=${e.data.keycode}${e.data.ctrl ? " +Ctrl" : ""}${e.data.alt ? " +Alt" : ""}${e.data.meta ? " +Meta" : ""}`;
          case "scroll":
            return `${e.ts}: Scroll at (${e.data.x}, ${e.data.y})`;
          default:
            return `${e.ts}: ${e.type}`;
        }
      })
      .join("\n");
  }

  private async analyzeWithGemini(
    timeline: string,
    screenshots: { ts: string; base64: string }[]
  ): Promise<GeminiAnalysis> {
    const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [
      { text: DETECTION_PROMPT },
      { text: `\n\n## Activity Timeline\n\n${timeline}` },
    ];

    // Add screenshots as inline images
    if (screenshots.length > 0) {
      parts.push({ text: `\n\n## Screenshots (${screenshots.length} captured during this session)\n` });
      for (const ss of screenshots) {
        parts.push({ text: `\n### Screenshot at ${ss.ts}\n` });
        parts.push({
          inlineData: { mimeType: "image/jpeg", data: ss.base64 },
        });
      }
    }

    const response = await this.genai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: [{ role: "user", parts }],
      config: {
        responseMimeType: "application/json",
      },
    });

    const text = response.text ?? "";
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
