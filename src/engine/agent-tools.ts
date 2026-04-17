import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { Type } from "@google/genai";
import type { Tool, ToolContext } from "./agent-types";

/**
 * The agent's tool registry. Each tool is a pure Node function behind a
 * Gemini function declaration. The agent-executor feeds declarations to
 * Gemini's function-calling loop and dispatches back here on every call.
 *
 * Scope for Stage 2:
 *   - filesystem (platform-aware desktop/documents resolution)
 *   - HTTP via node's built-in fetch
 *   - subprocess (run_command)
 *   - user interaction (ask_user) — bridged to the renderer
 *   - flow metadata (recall_observation) — exposes the flow body to the
 *     agent on demand rather than pre-stuffing the full doc into the
 *     system prompt every turn
 *   - browser (Playwright) — see agent-browser.ts; registered here
 *
 * Security posture: these tools inherit the host process's privileges.
 * Paths are NOT sandboxed (the agent can read/write anywhere the user
 * can). That's deliberate for Stage 2 — the user's stated workflows
 * span Desktop, Documents, OneDrive, etc., and a jail would block real
 * flows. Stage 3 will add per-flow "trusted" opt-in + step approval.
 */

// --- Filesystem ---------------------------------------------------------

const fsReadFile: Tool = {
  declaration: {
    name: "read_file",
    description:
      "Read the full contents of a text file. Returns { content } on success. Throws if the path doesn't exist or can't be read.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: "Absolute path to the file." },
      },
      required: ["path"],
    },
  },
  async invoke(args) {
    const p = String(args.path);
    const content = await fsp.readFile(p, "utf-8");
    return { path: p, content, bytes: Buffer.byteLength(content, "utf-8") };
  },
};

const fsWriteFile: Tool = {
  declaration: {
    name: "write_file",
    description:
      "Write a text file, creating parent directories as needed. Overwrites any existing file. Returns { path, bytes }.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING, description: "Absolute path to write." },
        content: { type: Type.STRING, description: "File contents to write." },
      },
      required: ["path", "content"],
    },
  },
  async invoke(args) {
    const p = String(args.path);
    const content = String(args.content ?? "");
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, content, "utf-8");
    return { path: p, bytes: Buffer.byteLength(content, "utf-8") };
  },
};

const fsListDir: Tool = {
  declaration: {
    name: "list_dir",
    description:
      "List the entries in a directory. Returns { path, entries: [{ name, isDir }] }. Does NOT recurse.",
    parameters: {
      type: Type.OBJECT,
      properties: { path: { type: Type.STRING } },
      required: ["path"],
    },
  },
  async invoke(args) {
    const p = String(args.path);
    const entries = await fsp.readdir(p, { withFileTypes: true });
    return {
      path: p,
      entries: entries.map((e) => ({ name: e.name, isDir: e.isDirectory() })),
    };
  },
};

const fsHomeDir: Tool = {
  declaration: {
    name: "home_dir",
    description: "Return the current user's home directory. Returns { path }.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  async invoke() {
    return { path: os.homedir() };
  },
};

/**
 * Windows-aware desktop path resolution. OneDrive-redirected desktops are
 * common — the "real" Desktop folder lives at %USERPROFILE%\OneDrive\Desktop,
 * not %USERPROFILE%\Desktop, when OneDrive's "Back up this folder" is on.
 * This was the bug that motivated Stage 1 in the first place; exposing a
 * proper resolver here means the agent never has to guess.
 */
const fsDesktopDir: Tool = {
  declaration: {
    name: "desktop_dir",
    description:
      "Return the current user's real Desktop folder. On Windows, prefers the OneDrive-redirected Desktop if present, falls back to the standard one.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  async invoke() {
    return { path: resolveUserFolder("Desktop") };
  },
};

const fsDocumentsDir: Tool = {
  declaration: {
    name: "documents_dir",
    description:
      "Return the current user's real Documents folder. On Windows, prefers the OneDrive-redirected Documents if present.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  async invoke() {
    return { path: resolveUserFolder("Documents") };
  },
};

const fsTempDir: Tool = {
  declaration: {
    name: "temp_dir",
    description: "Return a writable temporary directory. Returns { path }.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  async invoke() {
    return { path: os.tmpdir() };
  },
};

function resolveUserFolder(folderName: string): string {
  const home = os.homedir();
  const candidates = [path.join(home, "OneDrive", folderName), path.join(home, folderName)];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Nothing exists — return the default so the caller's "write_file" still
  // lands somewhere predictable, even if the user has to create the folder.
  return path.join(home, folderName);
}

// --- HTTP ---------------------------------------------------------------

const httpGet: Tool = {
  declaration: {
    name: "http_get",
    description:
      "Fetch a URL via HTTP GET. Returns { status, body, headers }. Body is truncated at 256 KB to keep the trace manageable.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING },
        headers: {
          type: Type.OBJECT,
          description: "Optional headers map as { name: value }.",
          properties: {},
        },
      },
      required: ["url"],
    },
  },
  async invoke(args) {
    const url = String(args.url);
    const headers = (args.headers as Record<string, string>) ?? {};
    const res = await fetch(url, { method: "GET", headers });
    const text = await res.text();
    return {
      url,
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body: truncate(text, 256 * 1024),
      bodyTruncated: text.length > 256 * 1024,
    };
  },
};

const httpPost: Tool = {
  declaration: {
    name: "http_post",
    description:
      "POST to a URL with a text body (typically JSON). Returns { status, body, headers }.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING },
        body: { type: Type.STRING, description: "Request body as a string. JSON callers should stringify beforehand." },
        headers: { type: Type.OBJECT, properties: {} },
      },
      required: ["url", "body"],
    },
  },
  async invoke(args) {
    const url = String(args.url);
    const body = String(args.body ?? "");
    const headers = (args.headers as Record<string, string>) ?? {};
    const res = await fetch(url, { method: "POST", headers, body });
    const text = await res.text();
    return {
      url,
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body: truncate(text, 256 * 1024),
      bodyTruncated: text.length > 256 * 1024,
    };
  },
};

const httpDownload: Tool = {
  declaration: {
    name: "download_file",
    description:
      "Download a URL and save it to a local path. Returns { dest, bytes, status }. Parent directories are created as needed.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING },
        dest: { type: Type.STRING, description: "Absolute destination path." },
      },
      required: ["url", "dest"],
    },
  },
  async invoke(args) {
    const url = String(args.url);
    const dest = String(args.dest);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buf);
    return { dest, bytes: buf.length, status: res.status };
  },
};

// --- Subprocess --------------------------------------------------------

const runCommand: Tool = {
  declaration: {
    name: "run_command",
    description:
      "Run a command with arguments and wait for it to exit. Returns { exitCode, stdout, stderr }. For quick one-offs; timeout is 30s.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        cmd: { type: Type.STRING, description: "Executable name or absolute path." },
        args: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "Argument list. Each item is a separate argv entry (no shell parsing).",
        },
        cwd: { type: Type.STRING, description: "Optional working directory." },
      },
      required: ["cmd"],
    },
  },
  async invoke(args) {
    const cmd = String(args.cmd);
    const argv = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [];
    const cwd = args.cwd ? String(args.cwd) : undefined;
    return await new Promise((resolve, reject) => {
      const child = spawn(cmd, argv, { cwd, shell: false, windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
        reject(new Error(`run_command timed out after 30s: ${cmd}`));
      }, 30_000);
      child.stdout?.on("data", (c) => { stdout += c.toString("utf-8"); });
      child.stderr?.on("data", (c) => { stderr += c.toString("utf-8"); });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({
          cmd,
          args: argv,
          exitCode: code ?? -1,
          stdout: truncate(stdout, 32 * 1024),
          stderr: truncate(stderr, 32 * 1024),
        });
      });
    });
  },
};

// --- User interaction -------------------------------------------------

const askUser: Tool = {
  declaration: {
    name: "ask_user",
    description:
      "Ask the user a question via the FlowMind UI and wait for their answer. Use ONLY when a value is truly not discoverable from the observation or parameters — prefer looking up params first.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: { type: Type.STRING, description: "Question to show the user." },
        kind: {
          type: Type.STRING,
          description: "text | yesno | choice",
        },
        choices: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: "Required when kind === 'choice'.",
        },
      },
      required: ["prompt", "kind"],
    },
  },
  async invoke(args, ctx: ToolContext) {
    const prompt = String(args.prompt);
    const kind = String(args.kind) as "text" | "yesno" | "choice";
    const choices = Array.isArray(args.choices) ? (args.choices as unknown[]).map(String) : undefined;
    const answer = await ctx.askUser(prompt, kind, choices);
    return { answer };
  },
};

// --- Flow metadata ----------------------------------------------------

const recallObservation: Tool = {
  declaration: {
    name: "recall_observation",
    description:
      "Return the slice of the flow body that mentions a given step or concept. Useful when the agent wants to check what the user actually did before deciding how to reproduce it. Matches as a case-insensitive substring; returns the surrounding lines.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Search string — word, phrase, step verb." },
      },
      required: ["query"],
    },
  },
  async invoke(args, ctx: ToolContext) {
    const query = String(args.query).toLowerCase();
    if (!query) return { query: "", matches: [] };
    const lines = ctx.flowBody.split("\n");
    const matches: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(query)) {
        const start = Math.max(0, i - 1);
        const end = Math.min(lines.length, i + 3);
        matches.push(lines.slice(start, end).join("\n"));
      }
    }
    return { query, matches: matches.slice(0, 5) };
  },
};

// --- Registry ---------------------------------------------------------

/**
 * All tools available to the agent, indexed by declaration name. The
 * browser tools live in agent-browser.ts and are merged in by the
 * executor — keeping them out of here avoids pulling playwright into
 * code paths that don't use it.
 */
export const CORE_TOOLS: Record<string, Tool> = Object.fromEntries(
  [
    fsReadFile,
    fsWriteFile,
    fsListDir,
    fsHomeDir,
    fsDesktopDir,
    fsDocumentsDir,
    fsTempDir,
    httpGet,
    httpPost,
    httpDownload,
    runCommand,
    askUser,
    recallObservation,
  ].map((t) => [t.declaration.name, t])
);

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n[... truncated ${text.length - max} chars ...]`;
}
