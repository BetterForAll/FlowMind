import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const BASE_DIR = path.join(os.homedir(), "flowmind-data", "descriptions");

export interface DescriptionFrontmatter {
  type: "description";
  id: string;
  sessionId: string;
  sessionDir: string;
  windowStart: string; // ISO
  windowEnd: string;   // ISO
  eventCount: number;
  screenshotCount: number;
  keyScreenshotCount: number;
  analyzed: boolean;
  /** True if this description was cited as a source by at least one detected flow. Linked descriptions are exempt from age-based cleanup. */
  linked: boolean;
}

export interface DescriptionDocument {
  frontmatter: DescriptionFrontmatter;
  body: string;
  filePath: string;
}

export interface KeyScreenshot {
  sourcePath: string; // path inside the raw session dir (temporary)
  ts: string;         // ISO timestamp as reported by the model
}

/**
 * Persistent store for phase-1 "description" artifacts.
 * Descriptions are human-readable markdown narratives of what the user did
 * during a small time window. They survive raw-session cleanup and serve as
 * the input to phase-2 flow detection.
 */
export class DescriptionStore {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? BASE_DIR;
  }

  async ensureDirectory(): Promise<void> {
    await fsp.mkdir(this.baseDir, { recursive: true });
  }

  async saveDescription(
    frontmatter: Omit<DescriptionFrontmatter, "keyScreenshotCount">,
    body: string,
    keyScreenshots: KeyScreenshot[] = []
  ): Promise<string> {
    const date = frontmatter.windowStart.slice(0, 10); // YYYY-MM-DD
    const dir = path.join(this.baseDir, date);
    await fsp.mkdir(dir, { recursive: true });

    // Filename: desc-<windowStartMs>-<short-id>.md — sorts chronologically
    const startMs = new Date(frontmatter.windowStart).getTime();
    const shortId = frontmatter.id.slice(-8);
    const base = `desc-${startMs}-${shortId}`;
    const filePath = path.join(dir, `${base}.md`);

    // Copy any key screenshots into a sibling .keys folder so they survive raw-session cleanup
    if (keyScreenshots.length > 0) {
      const keysDir = path.join(dir, `${base}.keys`);
      await fsp.mkdir(keysDir, { recursive: true });
      for (const ks of keyScreenshots) {
        try {
          const ms = new Date(ks.ts).getTime();
          if (isNaN(ms)) continue;
          const destPath = path.join(keysDir, `${ms}.jpg`);
          await fsp.copyFile(ks.sourcePath, destPath);
        } catch (err) {
          console.warn(`[DescriptionStore] Failed to copy key screenshot:`, err);
        }
      }
    }

    const finalFrontmatter: DescriptionFrontmatter = {
      ...frontmatter,
      keyScreenshotCount: keyScreenshots.length,
    };

    const content = serialize(finalFrontmatter, body);
    await fsp.writeFile(filePath, content, "utf-8");
    return filePath;
  }

  /** Return the narrative body of the most recent description for a session, or null. */
  async getLastNarrative(sessionId: string): Promise<string | null> {
    const all = await this.getAllDescriptions();
    const forSession = all.filter((d) => d.frontmatter.sessionId === sessionId);
    if (forSession.length === 0) return null;
    return forSession[forSession.length - 1].body;
  }

  /**
   * Return absolute paths of all key screenshots saved alongside a description file.
   * Returns empty array if the .keys folder doesn't exist.
   */
  async getKeyScreenshotPaths(descriptionFilePath: string): Promise<string[]> {
    const dir = path.dirname(descriptionFilePath);
    const base = path.basename(descriptionFilePath, ".md");
    const keysDir = path.join(dir, `${base}.keys`);
    if (!fs.existsSync(keysDir)) return [];
    const files = await fsp.readdir(keysDir);
    return files
      .filter((f) => f.endsWith(".jpg"))
      .sort() // chronological by ms filename
      .map((f) => path.join(keysDir, f));
  }

  /** Return all descriptions currently on disk, sorted chronologically. */
  async getAllDescriptions(): Promise<DescriptionDocument[]> {
    if (!fs.existsSync(this.baseDir)) return [];
    const docs: DescriptionDocument[] = [];

    const dateDirs = await fsp.readdir(this.baseDir);
    for (const dateDir of dateDirs) {
      const datePath = path.join(this.baseDir, dateDir);
      const stat = await fsp.stat(datePath).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const files = await fsp.readdir(datePath);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filePath = path.join(datePath, file);
        const raw = await fsp.readFile(filePath, "utf-8");
        const parsed = parse(raw);
        if (parsed) {
          docs.push({ ...parsed, filePath });
        }
      }
    }

    docs.sort(
      (a, b) =>
        new Date(a.frontmatter.windowStart).getTime() -
        new Date(b.frontmatter.windowStart).getTime()
    );
    return docs;
  }

  /** Return unanalyzed descriptions only, sorted chronologically. */
  async getUnanalyzedDescriptions(): Promise<DescriptionDocument[]> {
    const all = await this.getAllDescriptions();
    return all.filter((d) => !d.frontmatter.analyzed);
  }

  /** Find the most recent windowEnd for a given session — used to stitch consecutive windows. */
  async getLastWindowEnd(sessionId: string): Promise<string | null> {
    const all = await this.getAllDescriptions();
    const forSession = all.filter((d) => d.frontmatter.sessionId === sessionId);
    if (forSession.length === 0) return null;
    // getAllDescriptions sorts ascending, so last entry is latest
    return forSession[forSession.length - 1].frontmatter.windowEnd;
  }

  /** Flip `analyzed: true` for the given description file paths, rewriting in place. */
  async markAnalyzed(filePaths: string[]): Promise<void> {
    for (const fp of filePaths) {
      const raw = await fsp.readFile(fp, "utf-8").catch(() => null);
      if (!raw) continue;
      const parsed = parse(raw);
      if (!parsed) continue;
      const updated = {
        ...parsed.frontmatter,
        analyzed: true,
      };
      await fsp.writeFile(fp, serialize(updated, parsed.body), "utf-8");
    }
  }

  /**
   * Mark descriptions as `linked: true` by windowStart ISO timestamp.
   * Linked descriptions are exempt from age-based cleanup — they're the provenance
   * of a detected flow and we want to keep them around.
   */
  async markLinked(windowStarts: string[]): Promise<number> {
    if (windowStarts.length === 0) return 0;
    const wanted = new Set(windowStarts.map((w) => w.trim()));
    const all = await this.getAllDescriptions();
    let count = 0;
    for (const doc of all) {
      if (!wanted.has(doc.frontmatter.windowStart)) continue;
      if (doc.frontmatter.linked) continue;
      const updated = { ...doc.frontmatter, linked: true };
      await fsp.writeFile(doc.filePath, serialize(updated, doc.body), "utf-8");
      count++;
    }
    return count;
  }

  /**
   * Delete descriptions (and their .keys folders) older than `maxAgeMs`.
   * Linked descriptions (ones that contributed to a detected flow) are kept regardless of age.
   * Pass 0 to never delete.
   */
  async cleanupOld(maxAgeMs: number): Promise<number> {
    if (maxAgeMs <= 0) return 0;
    const all = await this.getAllDescriptions();
    const now = Date.now();
    let deleted = 0;
    for (const doc of all) {
      if (doc.frontmatter.linked) continue; // never auto-delete linked descriptions
      const age = now - new Date(doc.frontmatter.windowEnd).getTime();
      if (age > maxAgeMs) {
        await fsp.unlink(doc.filePath).catch(() => {});
        // Also remove the sibling .keys folder if it exists
        const base = path.basename(doc.filePath, ".md");
        const keysDir = path.join(path.dirname(doc.filePath), `${base}.keys`);
        await fsp.rm(keysDir, { recursive: true, force: true }).catch(() => {});
        deleted++;
      }
    }
    return deleted;
  }

  getBaseDir(): string {
    return this.baseDir;
  }
}

// --- Serialization helpers (minimal YAML frontmatter, matches FlowStore style) ---

function serialize(fm: DescriptionFrontmatter, body: string): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(fm)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push("---", "", body);
  return lines.join("\n");
}

function parse(
  raw: string
): { frontmatter: DescriptionFrontmatter; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;
  const fm: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();
    if (rawValue === "true") fm[key] = true;
    else if (rawValue === "false") fm[key] = false;
    else if (/^-?\d+$/.test(rawValue)) fm[key] = parseInt(rawValue, 10);
    else fm[key] = rawValue;
  }
  // Minimal validation — missing fields are fatal
  if (
    typeof fm.id !== "string" ||
    typeof fm.sessionId !== "string" ||
    typeof fm.windowStart !== "string" ||
    typeof fm.windowEnd !== "string"
  ) {
    return null;
  }
  return {
    frontmatter: {
      type: "description",
      id: fm.id,
      sessionId: fm.sessionId,
      sessionDir: (fm.sessionDir as string) ?? "",
      windowStart: fm.windowStart,
      windowEnd: fm.windowEnd,
      eventCount: (fm.eventCount as number) ?? 0,
      screenshotCount: (fm.screenshotCount as number) ?? 0,
      keyScreenshotCount: (fm.keyScreenshotCount as number) ?? 0,
      analyzed: fm.analyzed === true,
      linked: fm.linked === true,
    },
    body: match[2].trim(),
  };
}
