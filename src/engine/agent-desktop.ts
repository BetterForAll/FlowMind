import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { app } from "electron";
import path from "node:path";
import fs from "node:fs";
import { Type } from "@google/genai";
import type { Tool, ToolContext } from "./agent-types";

/**
 * Stage 3 — desktop control tools. These are thin wrappers around a
 * persistent Python helper process (resources/agent_tools.py) that
 * uses pywinauto + uiautomation + pyautogui to drive native Windows
 * apps via the UI Automation API and coordinate-based input.
 *
 * The Python process is spawned lazily on first use and reused for the
 * remainder of the agent run, then killed by closeDesktopSession() in
 * the executor's finally block. JSON-RPC over stdin/stdout — see the
 * helper's docstring for the wire format.
 *
 * Why Python (not Node):
 *   pywinauto exposes the Windows UI Automation accessibility tree —
 *   the only reliable way to "click the button with role=Button and
 *   name='Save'" without resorting to brittle pixel coordinates. The
 *   Node bindings for UIA are abandoned (windows.ui.automation) or
 *   require ffi-napi which fights with Electron's Node version.
 *   Python adds an install step but keeps the desktop layer rooted in
 *   the most mature available libraries.
 *
 * Failure mode: if Python or the required pip packages aren't
 * installed, every desktop tool's invoke() throws a precise
 * "DesktopHelperNotReady" error with install instructions. The agent
 * sees the error message and either re-routes (e.g. falls back to
 * vision_locate via screenshot) or asks the user to install via
 * ask_user.
 */

const PYTHON_BIN = process.platform === "win32" ? "python" : "python3";
const REQUIRED_PIP_PACKAGES = ["pywinauto", "uiautomation", "pyautogui", "pillow"];

/**
 * pip-name → import-name mapping for packages whose installable name
 * differs from their Python import name. The readiness probe uses
 * importlib.util.find_spec, which needs the import name. Without this,
 * `find_spec("pillow")` returns None even when pillow is installed
 * (the actual module is `PIL`), so the banner falsely flags it as
 * missing forever.
 *
 * Add new entries here as the agent's tool surface grows. Common
 * Python landmines: pillow→PIL, pyyaml→yaml, beautifulsoup4→bs4,
 * opencv-python→cv2, scikit-learn→sklearn.
 */
export const PIP_TO_IMPORT_NAME: Record<string, string> = {
  pillow: "PIL",
};

/** Translate a pip package name to the name used in `import X`. */
export function pipNameToImportName(pipName: string): string {
  return PIP_TO_IMPORT_NAME[pipName.toLowerCase()] ?? pipName;
}

/** Apply the mapping across an array, preserving order — used when
 *  building the python -c argv list for the readiness probe. */
export const REQUIRED_DESKTOP_IMPORTS = REQUIRED_PIP_PACKAGES.map(pipNameToImportName);

interface DesktopSession {
  child: ChildProcessWithoutNullStreams;
  /** Pending JSON-RPC requests awaiting a reply, keyed by request id. */
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  /** Monotonic id for new requests. */
  nextId: number;
  /** Buffered stdout — JSON responses are line-delimited but a chunk
   *  may not align with line boundaries. */
  stdoutBuffer: string;
  /** stderr accumulated for the lifetime of the session — used to
   *  enrich error messages when the helper dies unexpectedly. */
  stderr: string;
}

let activeSession: DesktopSession | null = null;

/**
 * Resolve the absolute path of the bundled agent_tools.py. Both packaged
 * builds (process.resourcesPath/resources/agent_tools.py) and
 * `npm start` dev mode (project root /resources/agent_tools.py) work.
 */
function helperPath(): string {
  const candidates = [
    // Packaged: forge.config.ts copyResourcesFolder put it here.
    path.join(process.resourcesPath ?? "", "resources", "agent_tools.py"),
    // Dev: app.getAppPath() points at project root.
    path.join(app.getAppPath(), "resources", "agent_tools.py"),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error(
    "agent_tools.py not found. Expected to be bundled in resources/. Reinstall FlowMind."
  );
}

/**
 * Lazy-spawn the Python helper. Subsequent callers wait on the same
 * session. Throws DesktopHelperNotReady with a precise install message
 * if Python or the pip dependencies are unavailable.
 */
async function getOrSpawnSession(): Promise<DesktopSession> {
  if (activeSession) return activeSession;

  const script = helperPath();
  const child = spawn(PYTHON_BIN, ["-u", script], {
    shell: false,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;

  const session: DesktopSession = {
    child,
    pending: new Map(),
    nextId: 1,
    stdoutBuffer: "",
    stderr: "",
  };

  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    session.stdoutBuffer += chunk;
    let nl = session.stdoutBuffer.indexOf("\n");
    while (nl !== -1) {
      const line = session.stdoutBuffer.slice(0, nl).trim();
      session.stdoutBuffer = session.stdoutBuffer.slice(nl + 1);
      if (line) handleResponse(session, line);
      nl = session.stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: string) => {
    session.stderr += chunk;
  });
  child.on("exit", (code) => {
    // Reject any in-flight request — the helper died.
    const reason = code === null ? "killed" : `exit ${code}`;
    const err = new DesktopHelperNotReady(
      `Python desktop helper exited (${reason}). stderr: ${session.stderr.slice(-1000) || "(empty)"}`
    );
    for (const { reject } of session.pending.values()) reject(err);
    session.pending.clear();
    if (activeSession === session) activeSession = null;
  });
  child.on("error", (err) => {
    // ENOENT etc. — Python isn't on PATH.
    for (const { reject } of session.pending.values()) {
      reject(new DesktopHelperNotReady(`Failed to spawn Python: ${err.message}`));
    }
    session.pending.clear();
    if (activeSession === session) activeSession = null;
  });

  activeSession = session;

  // Round-trip a ping so we know the helper imported successfully and
  // is responsive before the executor starts dispatching real tools.
  // 5 s is generous — Python startup + lazy imports finish well under
  // 1 s on a warm machine.
  try {
    await rpc(session, "ping", {}, 5000);
  } catch (err) {
    // Helper failed to start — usually means a pip dep is missing or
    // Python itself isn't installed. Tear down so the next attempt
    // re-spawns rather than reusing a dead session.
    closeDesktopSession();
    throw new DesktopHelperNotReady(
      `Desktop helper not ready: ${err instanceof Error ? err.message : String(err)}. ` +
        `Make sure Python is installed and run: pip install ${REQUIRED_PIP_PACKAGES.join(" ")}`
    );
  }
  return session;
}

function handleResponse(session: DesktopSession, line: string): void {
  let parsed: { id?: number; result?: unknown; error?: string };
  try {
    parsed = JSON.parse(line);
  } catch {
    // Helper printed a non-JSON line — log and ignore.
    console.warn(`[desktop helper] non-JSON line: ${line.slice(0, 200)}`);
    return;
  }
  if (parsed.id == null) return;
  const pending = session.pending.get(parsed.id);
  if (!pending) return;
  session.pending.delete(parsed.id);
  if (parsed.error) {
    pending.reject(new Error(parsed.error));
  } else {
    pending.resolve(parsed.result ?? {});
  }
}

/**
 * Send a JSON-RPC call to the helper. Returns the parsed `result`
 * field on success; throws with the helper's `error` string on
 * failure. Times out after `timeoutMs` (default 30 s — enough for
 * window-launch settle delays).
 */
async function rpc(
  session: DesktopSession,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<unknown> {
  const id = session.nextId++;
  const payload = JSON.stringify({ id, method, params });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`Desktop tool ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    session.pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    try {
      session.child.stdin.write(`${payload}\n`);
    } catch (err) {
      session.pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

/**
 * Close the helper process. Idempotent — safe to call from the
 * executor's finally block whether or not a session was ever spawned.
 */
export function closeDesktopSession(): void {
  if (!activeSession) return;
  const s = activeSession;
  activeSession = null;
  try {
    // Closing stdin tells the helper's main loop to exit cleanly.
    s.child.stdin.end();
  } catch {
    /* already gone */
  }
  // SIGKILL after a 1 s grace window in case the helper hung in a tool call.
  setTimeout(() => {
    try {
      s.child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }, 1000);
}

/** Thrown when Python or the required pip packages aren't ready. The
 * UI catches this and surfaces a single "Install Python desktop tools"
 * banner instead of grinding through tool-by-tool errors. */
export class DesktopHelperNotReady extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopHelperNotReady";
  }
}

// ----- Tool wrappers --------------------------------------------------

/**
 * Convenience: wrap an RPC call in a Tool. The `params` shape passed to
 * the model's function declaration becomes the JSON-RPC params on the
 * Python side — they're 1:1 by design, so the docstrings on
 * agent_tools.py and these declarations match.
 */
function rpcTool(decl: Tool["declaration"]): Tool {
  return {
    declaration: decl,
    async invoke(args, _ctx: ToolContext) {
      const session = await getOrSpawnSession();
      const result = await rpc(session, decl.name, args);
      return (result ?? {}) as Record<string, unknown>;
    },
  };
}

const desktopTools: Tool[] = [
  rpcTool({
    name: "window_list",
    description:
      "Enumerate top-level windows with titles, handles, and PIDs. Returns { windows: [...] }. Use this to find a window before window_focus.",
    parameters: { type: Type.OBJECT, properties: {} },
  }),
  rpcTool({
    name: "window_focus",
    description:
      "Bring a window to the foreground. Pass either { handle: number } (preferred — stable) or { title: string } (substring, case-insensitive).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        handle: { type: Type.NUMBER },
        title: { type: Type.STRING },
      },
    },
  }),
  rpcTool({
    name: "app_launch",
    description:
      "Spawn an executable. { path: string, args?: string[] }. Returns the new pid.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        path: { type: Type.STRING },
        args: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ["path"],
    },
  }),
  rpcTool({
    name: "control_click",
    description:
      "Click a UI control inside a window via UI Automation. Robust against window moves/themes — uses accessibility tree, not pixel coordinates. { window: title-substring, name?, role?, automation_id? }.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        window: { type: Type.STRING, description: "Window title substring." },
        name: { type: Type.STRING, description: "Control accessible name." },
        role: {
          type: Type.STRING,
          description: "Control type: Button, Edit, ComboBox, MenuItem, etc.",
        },
        automation_id: { type: Type.STRING, description: "Stable AutomationId if known." },
      },
      required: ["window"],
    },
  }),
  rpcTool({
    name: "control_type",
    description:
      "Type text into a UI control. Existing content is NOT cleared — send Ctrl+A + Delete via keyboard_send first if needed.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        window: { type: Type.STRING },
        name: { type: Type.STRING },
        role: { type: Type.STRING },
        automation_id: { type: Type.STRING },
        text: { type: Type.STRING },
      },
      required: ["window", "text"],
    },
  }),
  rpcTool({
    name: "keyboard_send",
    description:
      "Send keys to the foreground window. Use named keys ('enter', 'tab', 'escape') or hotkey combos ('ctrl+s', 'alt+f4'). For typing into a control, prefer control_type.",
    parameters: {
      type: Type.OBJECT,
      properties: { keys: { type: Type.STRING } },
      required: ["keys"],
    },
  }),
  rpcTool({
    name: "screen_screenshot",
    description:
      "Capture the primary monitor as a PNG. Returns { path, width, height }. Pair with vision_locate when an element has no accessibility info.",
    parameters: { type: Type.OBJECT, properties: {} },
  }),
  rpcTool({
    name: "mouse_click_at",
    description:
      "Coordinate-based click — fallback for elements UIA can't reach. Get coordinates from vision_locate. { x, y, button?, double? }.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        x: { type: Type.NUMBER },
        y: { type: Type.NUMBER },
        button: { type: Type.STRING },
        double: { type: Type.BOOLEAN },
      },
      required: ["x", "y"],
    },
  }),
];

export const DESKTOP_TOOLS: Record<string, Tool> = Object.fromEntries(
  desktopTools.map((t) => [t.declaration.name, t])
);

/** Re-exported so callers (executor, install-prompt) can show the
 *  exact list to the user without hard-coding it twice. */
export const REQUIRED_DESKTOP_PACKAGES = REQUIRED_PIP_PACKAGES;
