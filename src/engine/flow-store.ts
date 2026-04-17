import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  AutomationFile,
  FlowDocument,
  FlowFrontmatter,
  KnowledgeDocument,
  KnowledgeFrontmatter,
} from "../types";

const BASE_DIR = path.join(os.homedir(), "flowtracker");

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
    const slug = this.slugify(frontmatter.name);
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

  /**
   * Merge evidence from a newly-detected flow into an existing flow file.
   * Only frontmatter metadata is updated (occurrences, last_seen, source_windows, apps).
   * The body is preserved as-is — body refinement is a separate, opt-in step.
   *
   * Throws if the target file doesn't exist or can't be parsed.
   */
  async mergeFlow(
    filePath: string,
    merge: { newSourceWindows?: string[]; newApps?: string[]; now?: string }
  ): Promise<void> {
    const raw = await fsp.readFile(filePath, "utf-8");
    const parsed = this.parseDocument(raw);
    if (!parsed) throw new Error(`Cannot parse flow file for merge: ${filePath}`);

    const existing = parsed.frontmatter as unknown as FlowFrontmatter;
    const now = merge.now ?? new Date().toISOString();

    const mergedSourceWindows = Array.from(
      new Set([...(existing.source_windows ?? []), ...(merge.newSourceWindows ?? [])])
    );
    const mergedApps = Array.from(
      new Set([...(existing.apps ?? []), ...(merge.newApps ?? [])])
    );

    const updated: FlowFrontmatter = {
      ...existing,
      occurrences: (existing.occurrences ?? 1) + 1,
      last_seen: now,
      source_windows: mergedSourceWindows,
      apps: mergedApps,
    };

    await fsp.writeFile(filePath, this.serializeDocument({ ...updated }, parsed.body), "utf-8");
  }

  /**
   * Save a generated automation file for a flow.
   * Filename pattern: <flow-slug>-<format>.<ext>
   * Exactly one file per (flow, format) pair. Regeneration overwrites.
   * Also removes any legacy date-prefixed or counter-suffixed files from the
   * old scheme so the list stays clean after upgrade.
   */
  async saveAutomation(
    name: string,
    content: string,
    format: string,
    ext: string
  ): Promise<string> {
    const slug = this.slugify(name);
    const dir = path.join(this.baseDir, "automations");
    await fsp.mkdir(dir, { recursive: true });

    // Clean up any legacy files for this (flow, format) — old dated/counter names
    try {
      const existing = await fsp.readdir(dir);
      const legacyPattern = new RegExp(
        `^(?:\\d{4}-\\d{2}-\\d{2}-)?${escapeRegExp(slug)}-${escapeRegExp(format)}(?:-\\d+)?\\.[a-z0-9]+$`
      );
      for (const f of existing) {
        if (legacyPattern.test(f)) {
          await fsp.unlink(path.join(dir, f)).catch(() => {});
        }
      }
    } catch { /* ignore */ }

    const filename = `${slug}-${format}.${ext}`;
    const filePath = path.join(dir, filename);
    await fsp.writeFile(filePath, content, "utf-8");
    return filePath;
  }

  /**
   * List all automation files generated for a given flow name.
   * Matches both the new scheme (<slug>-<format>.<ext>) and legacy dated/counter names.
   * For each format, returns the newest file only.
   */
  async listAutomationsForFlow(flowName: string): Promise<AutomationFile[]> {
    const dir = path.join(this.baseDir, "automations");
    if (!fs.existsSync(dir)) return [];

    const slug = this.slugify(flowName);
    const files = await fsp.readdir(dir);
    const byFormat = new Map<string, AutomationFile>();

    // Match both new and legacy patterns:
    //   New:    <slug>-<format>.<ext>
    //   Legacy: <date>-<slug>-<format>(-N)?.<ext>
    const pattern = new RegExp(
      `^(?:\\d{4}-\\d{2}-\\d{2}-)?${escapeRegExp(slug)}-([a-z-]+?)(?:-\\d+)?\\.([a-z0-9]+)$`
    );

    for (const f of files) {
      const m = f.match(pattern);
      if (!m) continue;
      const [, format, ext] = m;
      const filePath = path.join(dir, f);
      try {
        const stat = await fsp.stat(filePath);
        const entry: AutomationFile = {
          filePath,
          filename: f,
          format,
          ext,
          createdAt: stat.mtime.toISOString(),
          sizeBytes: stat.size,
        };
        const existing = byFormat.get(format);
        if (!existing || new Date(entry.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
          byFormat.set(format, entry);
        }
      } catch { /* skip unreadable */ }
    }

    return Array.from(byFormat.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  async deleteAutomation(filePath: string): Promise<void> {
    // Safety: only allow deleting files inside our automations directory
    const automationsDir = path.join(this.baseDir, "automations");
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(automationsDir))) {
      throw new Error("Refusing to delete file outside automations directory");
    }
    await fsp.unlink(resolved);
  }

  /**
   * Predict the final absolute path `saveAutomation` will use for a given
   * (flow, format, ext). Used by callers that need to embed the path inside
   * the file content before saving.
   */
  predictAutomationPath(name: string, format: string, ext: string): string {
    const slug = this.slugify(name);
    return path.join(this.baseDir, "automations", `${slug}-${format}.${ext}`);
  }

  async readAutomation(filePath: string): Promise<string> {
    const automationsDir = path.join(this.baseDir, "automations");
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(automationsDir))) {
      throw new Error("Refusing to read file outside automations directory");
    }
    return fsp.readFile(resolved, "utf-8");
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
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
