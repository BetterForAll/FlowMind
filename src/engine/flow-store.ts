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

export interface RunLogEntry {
  filePath: string;
  filename: string;
  /** ISO timestamp parsed from the log header. */
  startedAt: string;
  /** ISO timestamp parsed from the log footer. Null if the log never closed (crash). */
  endedAt: string | null;
  /** Milliseconds between start and end, or null if the log has no footer. */
  durationMs: number | null;
  /** Process exit code, null when killed/timed-out/errored. */
  exitCode: number | null;
  /** Terminal state: completed | killed | timeout | error. Null for unclosed logs. */
  reason: string | null;
  sizeBytes: number;
}

const BASE_DIR = path.join(os.homedir(), "flowtracker");

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse the `# key: value` header/footer lines AutomationRunner writes around
 * each log's body. Only reads the top 30 and bottom 30 lines to stay fast on
 * large logs.
 */
async function parseLogMetadata(filePath: string): Promise<Omit<RunLogEntry, "filePath" | "filename">> {
  const raw = await fsp.readFile(filePath, "utf-8");
  const stat = await fsp.stat(filePath);
  const lines = raw.split("\n");
  const firstBlock = lines.slice(0, 30).join("\n");
  const lastBlock = lines.slice(-30).join("\n");
  const grab = (blob: string, key: string): string | null => {
    const m = blob.match(new RegExp(`^# ${key}:\\s*(.*)$`, "m"));
    return m ? m[1].trim() : null;
  };
  const startedAt = grab(firstBlock, "started") ?? stat.mtime.toISOString();
  const endedAt = grab(lastBlock, "ended");
  const exitCodeRaw = grab(lastBlock, "exit_code");
  const durationRaw = grab(lastBlock, "duration_ms");
  const reason = grab(lastBlock, "reason");
  return {
    startedAt,
    endedAt,
    durationMs: durationRaw != null && /^\d+$/.test(durationRaw) ? parseInt(durationRaw, 10) : null,
    exitCode: exitCodeRaw != null && /^-?\d+$/.test(exitCodeRaw) ? parseInt(exitCodeRaw, 10) : null,
    reason,
    sizeBytes: stat.size,
  };
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
   * Atomically promote a partial flow to a complete flow:
   *   1. Save the complete version to `flows/complete/`.
   *   2. Unlink the original partial file on success.
   *
   * The complete frontmatter should have `type: "complete-flow"` and keep the
   * original `id` so any code that tracked the partial flow by id continues
   * to find it (now as a complete flow).
   *
   * Returns the new complete file path.
   */
  async promotePartialToComplete(
    partialFilePath: string,
    completeFrontmatter: FlowFrontmatter,
    completeBody: string
  ): Promise<string> {
    const newPath = await this.saveFlow("complete", completeFrontmatter, completeBody);
    await fsp.unlink(partialFilePath).catch(() => {});
    return newPath;
  }

  /**
   * Merge evidence from a newly-detected flow into an existing flow file.
   * Only frontmatter metadata is updated (occurrences, last_seen,
   * source_windows, apps, and optionally the worth fields). The body is
   * preserved as-is — body refinement is a separate, opt-in step.
   *
   * If `worth` is supplied, it overwrites any existing worth fields so the
   * classification reflects the freshly-merged state (new occurrence count,
   * new time-saved estimate).
   *
   * Throws if the target file doesn't exist or can't be parsed.
   */
  async mergeFlow(
    filePath: string,
    merge: {
      newSourceWindows?: string[];
      newApps?: string[];
      now?: string;
      worth?: FlowFrontmatter["worth"];
      worth_reason?: string;
      time_saved_estimate_minutes?: number;
    }
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
      ...(merge.worth !== undefined ? { worth: merge.worth } : {}),
      ...(merge.worth_reason !== undefined ? { worth_reason: merge.worth_reason } : {}),
      ...(merge.time_saved_estimate_minutes !== undefined
        ? { time_saved_estimate_minutes: merge.time_saved_estimate_minutes }
        : {}),
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

  /**
   * List run-log files for a given flow + automation format, newest first.
   * Log layout: <automations>/logs/<flow-slug>-<format>/<format>-<timestamp>.log
   * Each entry includes parsed metadata (start/end/exit/duration) read from
   * the log's header and footer comment lines.
   */
  async listRunLogs(flowName: string, format: string): Promise<RunLogEntry[]> {
    const slug = this.slugify(flowName);
    const logsRoot = path.join(this.baseDir, "automations", "logs", `${slug}-${format}`);
    if (!fs.existsSync(logsRoot)) return [];

    const files = await fsp.readdir(logsRoot);
    const entries: RunLogEntry[] = [];
    for (const f of files) {
      if (!f.endsWith(".log")) continue;
      const filePath = path.join(logsRoot, f);
      try {
        const meta = await parseLogMetadata(filePath);
        entries.push({ filePath, filename: f, ...meta });
      } catch {
        // Malformed log: still include it so the user can see + delete it.
        const stat = await fsp.stat(filePath).catch(() => null);
        entries.push({
          filePath,
          filename: f,
          startedAt: stat?.mtime.toISOString() ?? new Date(0).toISOString(),
          endedAt: null,
          durationMs: null,
          exitCode: null,
          reason: null,
          sizeBytes: stat?.size ?? 0,
        });
      }
    }
    entries.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return entries;
  }

  async readRunLog(filePath: string): Promise<string> {
    const logsRoot = path.join(this.baseDir, "automations", "logs");
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(logsRoot))) {
      throw new Error("Refusing to read file outside logs directory");
    }
    return fsp.readFile(resolved, "utf-8");
  }

  async deleteRunLog(filePath: string): Promise<void> {
    const logsRoot = path.join(this.baseDir, "automations", "logs");
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(logsRoot))) {
      throw new Error("Refusing to delete file outside logs directory");
    }
    await fsp.unlink(resolved);
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
