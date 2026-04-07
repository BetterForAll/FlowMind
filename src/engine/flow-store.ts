import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  FlowDocument,
  FlowFrontmatter,
  KnowledgeDocument,
  KnowledgeFrontmatter,
} from "../types";

const BASE_DIR = path.join(os.homedir(), "flowtracker");

export class FlowStore {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? BASE_DIR;
  }

  async ensureDirectories(): Promise<void> {
    const dirs = [
      path.join(this.baseDir, "flows", "complete"),
      path.join(this.baseDir, "flows", "partial"),
      path.join(this.baseDir, "knowledge"),
      path.join(this.baseDir, "automations"),
    ];
    for (const dir of dirs) {
      await fsp.mkdir(dir, { recursive: true });
    }
  }

  async getAllFlows(): Promise<{
    complete: FlowDocument[];
    partial: FlowDocument[];
  }> {
    const complete = await this.readFlowDir(
      path.join(this.baseDir, "flows", "complete")
    );
    const partial = await this.readFlowDir(
      path.join(this.baseDir, "flows", "partial")
    );
    return { complete, partial };
  }

  async getFlowById(id: string): Promise<FlowDocument | null> {
    const { complete, partial } = await this.getAllFlows();
    return (
      complete.find((f) => f.frontmatter.id === id) ??
      partial.find((f) => f.frontmatter.id === id) ??
      null
    );
  }

  async getAllKnowledge(): Promise<KnowledgeDocument[]> {
    return this.readKnowledgeDir(path.join(this.baseDir, "knowledge"));
  }

  async saveFlow(
    type: "complete" | "partial",
    frontmatter: FlowFrontmatter,
    body: string
  ): Promise<string> {
    const subdir = type === "complete" ? "flows/complete" : "flows/partial";
    const date = new Date().toISOString().slice(0, 10);
    const slug = frontmatter.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const filename = `${date}-${slug}.md`;
    const filePath = path.join(this.baseDir, subdir, filename);

    const content = this.serializeDocument({ ...frontmatter }, body);
    await fsp.writeFile(filePath, content, "utf-8");
    return filePath;
  }

  async saveKnowledge(
    frontmatter: KnowledgeFrontmatter,
    body: string
  ): Promise<string> {
    const date = new Date().toISOString().slice(0, 10);
    const slug = body
      .split("\n")[0]
      .replace(/^#\s*/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 50);
    const filename = `${date}-${slug}.md`;
    const filePath = path.join(this.baseDir, "knowledge", filename);

    const content = this.serializeDocument({ ...frontmatter }, body);
    await fsp.writeFile(filePath, content, "utf-8");
    return filePath;
  }

  async updateFlow(filePath: string, frontmatter: FlowFrontmatter, body: string): Promise<void> {
    const content = this.serializeDocument({ ...frontmatter }, body);
    await fsp.writeFile(filePath, content, "utf-8");
  }

  async saveAutomation(name: string, content: string, ext: string): Promise<string> {
    const date = new Date().toISOString().slice(0, 10);
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    const filename = `${date}-${slug}.${ext}`;
    const filePath = path.join(this.baseDir, "automations", filename);
    await fsp.writeFile(filePath, content, "utf-8");
    return filePath;
  }

  async saveSummary(summary: string): Promise<void> {
    const filePath = path.join(this.baseDir, "latest-run.md");
    await fsp.writeFile(filePath, summary, "utf-8");
  }

  // --- Private helpers ---

  private async readFlowDir(dirPath: string): Promise<FlowDocument[]> {
    if (!fs.existsSync(dirPath)) return [];
    const files = await fsp.readdir(dirPath);
    const docs: FlowDocument[] = [];

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const filePath = path.join(dirPath, file);
      const raw = await fsp.readFile(filePath, "utf-8");
      const parsed = this.parseDocument(raw);
      if (parsed) {
        docs.push({
          frontmatter: parsed.frontmatter as unknown as FlowFrontmatter,
          body: parsed.body,
          filePath,
        });
      }
    }

    return docs.sort(
      (a, b) =>
        new Date(b.frontmatter.last_seen).getTime() -
        new Date(a.frontmatter.last_seen).getTime()
    );
  }

  private async readKnowledgeDir(dirPath: string): Promise<KnowledgeDocument[]> {
    if (!fs.existsSync(dirPath)) return [];
    const files = await fsp.readdir(dirPath);
    const docs: KnowledgeDocument[] = [];

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const filePath = path.join(dirPath, file);
      const raw = await fsp.readFile(filePath, "utf-8");
      const parsed = this.parseDocument(raw);
      if (parsed) {
        docs.push({
          frontmatter: parsed.frontmatter as unknown as KnowledgeFrontmatter,
          body: parsed.body,
          filePath,
        });
      }
    }

    return docs.sort(
      (a, b) =>
        new Date(b.frontmatter.detected).getTime() -
        new Date(a.frontmatter.detected).getTime()
    );
  }

  private parseDocument(
    raw: string
  ): { frontmatter: Record<string, unknown>; body: string } | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return null;

    const frontmatter: Record<string, unknown> = {};
    for (const line of match[1].split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      let value: unknown = line.slice(colonIdx + 1).trim();

      // Parse arrays like [app1, app2]
      if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
        value = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim());
      }
      // Parse numbers
      else if (typeof value === "string" && /^\d+$/.test(value)) {
        value = parseInt(value, 10);
      }

      frontmatter[key] = value;
    }

    return { frontmatter, body: match[2].trim() };
  }

  private serializeDocument(
    frontmatter: Record<string, unknown>,
    body: string
  ): string {
    const lines: string[] = ["---"];
    for (const [key, value] of Object.entries(frontmatter)) {
      if (Array.isArray(value)) {
        lines.push(`${key}: [${value.join(", ")}]`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    }
    lines.push("---", "", body);
    return lines.join("\n");
  }
}
