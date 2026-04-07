import { GoogleGenAI } from "@google/genai";
import { FlowStore } from "./flow-store";
import type { InterviewQuestion, FlowDocument } from "../types";

const AUTOMATION_PROMPT = `You are FlowMind, an AI that generates automations from documented workflows.

Given the complete flow document below, generate the requested output format.

RULES:
- The automation must faithfully implement ALL steps in the flow
- Include error handling for external service calls
- Add comments explaining decision logic
- Never hardcode sensitive values — use environment variables
- Mark steps that need human approval with clear prompts

Respond with ONLY the requested code/document, no explanations.`;

export class InterviewEngine {
  private store: FlowStore;
  private genai: GoogleGenAI;

  constructor(store: FlowStore) {
    this.store = store;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    this.genai = new GoogleGenAI({ apiKey });
  }

  async getQuestions(flowId: string): Promise<InterviewQuestion[]> {
    const flow = await this.store.getFlowById(flowId);
    if (!flow) throw new Error(`Flow not found: ${flowId}`);
    if (flow.frontmatter.type !== "partial-flow") {
      return []; // complete flows have no questions
    }

    const questions: InterviewQuestion[] = [];
    const lines = flow.body.split("\n");
    let inQuestions = false;
    let index = 0;

    for (const line of lines) {
      if (line.includes("## Questions to Complete This Flow")) {
        inQuestions = true;
        continue;
      }
      if (inQuestions && line.startsWith("##")) break;
      if (inQuestions && line.startsWith("- Q")) {
        const questionText = line.replace(/^- Q\d+:\s*/, "").trim();
        questions.push({
          index,
          question: questionText,
          answered: false,
        });
        index++;
      }
    }

    return questions;
  }

  async submitAnswer(
    flowId: string,
    questionIndex: number,
    answer: string
  ): Promise<{ promoted: boolean }> {
    const flow = await this.store.getFlowById(flowId);
    if (!flow) throw new Error(`Flow not found: ${flowId}`);

    // Parse existing questions and mark the answered one
    const questions = await this.getQuestions(flowId);
    if (questionIndex < 0 || questionIndex >= questions.length) {
      throw new Error(`Invalid question index: ${questionIndex}`);
    }

    questions[questionIndex].answered = true;
    questions[questionIndex].answer = answer;

    // Rebuild the body with the answer inserted
    const updatedBody = this.insertAnswer(flow, questionIndex, answer);

    // Check if all questions are answered
    const allAnswered = questions.every((q) => q.answered);

    if (allAnswered) {
      // Promote to complete flow
      const promoted = await this.promoteToComplete(flow, updatedBody);
      return { promoted: true };
    }

    // Update the partial flow with the answer
    await this.store.updateFlow(flow.filePath, flow.frontmatter, updatedBody);
    return { promoted: false };
  }

  async generateAutomation(
    flowId: string,
    format: string
  ): Promise<{ filePath: string; content: string }> {
    const flow = await this.store.getFlowById(flowId);
    if (!flow) throw new Error(`Flow not found: ${flowId}`);
    if (flow.frontmatter.type !== "complete-flow") {
      throw new Error("Can only generate automations from complete flows");
    }

    const formatInstructions: Record<string, { ext: string; instruction: string }> = {
      python: {
        ext: "py",
        instruction: "Generate a Python script that automates this workflow. Use standard libraries where possible, subprocess for CLI tools, and requests for HTTP calls.",
      },
      nodejs: {
        ext: "js",
        instruction: "Generate a Node.js script that automates this workflow. Use built-in modules and fetch for HTTP calls.",
      },
      "claude-skill": {
        ext: "md",
        instruction: "Generate a Claude Code skill (.md file) that can be used to execute this workflow interactively with a human.",
      },
      tutorial: {
        ext: "md",
        instruction: "Generate a step-by-step tutorial document that teaches someone how to perform this workflow manually.",
      },
    };

    const fmt = formatInstructions[format];
    if (!fmt) {
      throw new Error(`Unknown format: ${format}. Use: python, nodejs, claude-skill, tutorial`);
    }

    const response = await this.genai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: [
        {
          role: "user",
          parts: [
            { text: AUTOMATION_PROMPT },
            { text: `\n\n## Format\n${fmt.instruction}` },
            { text: `\n\n## Flow Document\n${flow.body}` },
          ],
        },
      ],
    });

    const content = response.text ?? "";
    const filePath = await this.store.saveAutomation(
      flow.frontmatter.name,
      content,
      fmt.ext
    );

    return { filePath, content };
  }

  private insertAnswer(flow: FlowDocument, questionIndex: number, answer: string): string {
    const lines = flow.body.split("\n");
    const result: string[] = [];
    let qIdx = 0;
    let inQuestions = false;

    for (const line of lines) {
      if (line.includes("## Questions to Complete This Flow")) {
        inQuestions = true;
      }
      if (inQuestions && line.startsWith("##") && !line.includes("Questions")) {
        inQuestions = false;
      }

      result.push(line);

      if (inQuestions && line.startsWith("- Q") && qIdx === questionIndex) {
        result.push(`  **Answer:** ${answer}`);
      }
      if (inQuestions && line.startsWith("- Q")) {
        qIdx++;
      }
    }

    return result.join("\n");
  }

  private async promoteToComplete(
    flow: FlowDocument,
    bodyWithAnswers: string
  ): Promise<boolean> {
    // Use Gemini to synthesize the partial flow + answers into a complete flow
    const response = await this.genai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Convert this partial flow into a complete flow document. Use the answers provided to fill in the gaps. Output ONLY the markdown body (no frontmatter), following this structure:

# Flow Name

## Trigger
...

## Steps
1. Step (use IF/ELSE, FOR EACH where appropriate)

## Decision Logic
- condition: how user decides

## Tools & Data Sources
- App: read/write/both

## Automation Classification
- Deterministic steps: list
- AI-required steps: list + why
- Human-approval-required: list + why

## Variations Observed
- variation`,
            },
            { text: `\n\n## Partial Flow with Answers\n${bodyWithAnswers}` },
          ],
        },
      ],
    });

    const completeBody = response.text ?? bodyWithAnswers;

    // Save as complete flow
    const newFrontmatter = {
      ...flow.frontmatter,
      type: "complete-flow" as const,
      confidence: "medium" as const,
    };
    delete (newFrontmatter as Record<string, unknown>).gaps;

    await this.store.saveFlow("complete", newFrontmatter, completeBody);
    // Remove the partial flow file
    const fsp = await import("node:fs/promises");
    await fsp.unlink(flow.filePath).catch(() => {});

    return true;
  }
}
