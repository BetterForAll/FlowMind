/**
 * Extract external (non-stdlib / non-builtin) dependencies from an automation
 * script's source text.
 *
 * Used by:
 *  - The usage-hint generator in interview.ts, which writes the `pip install`
 *    / `npm install` line at the top of the file.
 *  - The Install-deps flow in the FlowDetail UI, which reuses the same list
 *    to prompt the user to install missing packages before running.
 *
 * Keeping both callers on one implementation ensures the "Install" button
 * installs exactly what the usage hint says the script needs.
 */

// Common Python stdlib — anything else in an `import X` / `from X import` is
// treated as a third-party dep.
const PYTHON_STDLIB = new Set([
  "os", "sys", "re", "json", "time", "datetime", "pathlib", "subprocess", "shutil",
  "random", "math", "collections", "itertools", "functools", "typing", "logging",
  "argparse", "io", "tempfile", "glob", "csv", "sqlite3", "urllib", "http", "email",
  "base64", "hashlib", "hmac", "uuid", "threading", "multiprocessing", "asyncio",
  "concurrent", "queue", "socket", "ssl", "xml", "html", "string", "textwrap", "traceback",
]);

// Node builtins — anything else in `require('X')` / `import from 'X'` is
// treated as a third-party dep (unless it starts with `.` / `/`).
const NODE_BUILTINS = new Set([
  "fs", "path", "os", "crypto", "http", "https", "url", "querystring", "stream",
  "util", "events", "child_process", "readline", "assert", "buffer", "process",
  "timers", "zlib", "dns", "net", "tls", "v8", "worker_threads",
]);

/**
 * Return the list of non-stdlib / non-builtin packages imported by a script.
 * Deduplicated, sorted for stable ordering.
 */
export function detectExternalDeps(content: string, format: "python" | "nodejs"): string[] {
  const all = format === "python" ? detectPythonImports(content) : detectNodeImports(content);
  const allowed = format === "python" ? PYTHON_STDLIB : NODE_BUILTINS;
  const external = all.filter((name) => !allowed.has(name) && !name.startsWith("."));
  return Array.from(new Set(external)).sort();
}

export function detectPythonImports(content: string): string[] {
  const imports = new Set<string>();
  for (const line of content.split("\n")) {
    const m1 = line.match(/^\s*import\s+([a-zA-Z_][\w.]*)/);
    const m2 = line.match(/^\s*from\s+([a-zA-Z_][\w.]*)\s+import/);
    const name = (m1?.[1] ?? m2?.[1] ?? "").split(".")[0];
    if (name) imports.add(name);
  }
  return Array.from(imports);
}

export function detectNodeImports(content: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /require\(['"]([^'"]+)['"]\)/g,
    /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(content)) !== null) {
      const raw = m[1];
      if (!raw.startsWith(".")) {
        // Strip scoped-package sub-paths (e.g. @scope/pkg/sub → @scope/pkg)
        const parts = raw.split("/");
        imports.add(raw.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
      }
    }
  }
  return Array.from(imports);
}

/**
 * Filter `detectExternalDeps`'s output down to packages that aren't
 * actually importable in the runtime the script will use. This is what
 * the "Install" banner in the UI should consume — without it, the user
 * sees "install requests" even when `requests` is already on the path,
 * because the static import scanner has no idea what's installed.
 *
 * Strategy:
 *   - Python: spawn `python -c` with importlib.util.find_spec for each
 *     declared import. Fast (one subprocess), works against the SAME
 *     interpreter we'd run the script with via pickCommand.
 *   - Node:   spawn `node -e` running `require.resolve` from the script's
 *     directory. Mirrors how the runner spawns the script, so package
 *     resolution sees the same `node_modules` walk.
 *
 * Failures fall safe: if the interpreter can't be invoked at all (Python
 * not installed, Node missing) we return the full declared list — the
 * existing missing-interpreter banner will tell the user to install the
 * runtime in the first place.
 */
export async function findMissingDeps(
  content: string,
  format: "python" | "nodejs",
  scriptDir: string
): Promise<string[]> {
  const declared = detectExternalDeps(content, format);
  if (declared.length === 0) return [];
  return format === "python"
    ? checkMissingPython(declared)
    : checkMissingNode(declared, scriptDir);
}

async function checkMissingPython(packages: string[]): Promise<string[]> {
  const { spawn } = await import("node:child_process");
  const bin = process.platform === "win32" ? "python" : "python3";
  // One subprocess, one line of stdout per missing package. find_spec
  // returns None when the import isn't resolvable; we never actually
  // import anything, so heavy/slow side-effecting modules don't run.
  const code = [
    "import importlib.util, sys",
    "for p in sys.argv[1:]:",
    "    if importlib.util.find_spec(p) is None:",
    "        print(p)",
  ].join("\n");
  return new Promise<string[]>((resolve) => {
    const child = spawn(bin, ["-c", code, ...packages], { shell: false, windowsHide: true });
    let stdout = "";
    child.stdout?.on("data", (c) => { stdout += c.toString("utf-8"); });
    child.on("error", () => resolve(packages));
    child.on("exit", (code) => {
      if (code !== 0 && stdout.length === 0) {
        // Couldn't run python at all — fall safe and assume missing.
        resolve(packages);
        return;
      }
      const missing = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      resolve(missing);
    });
  });
}

async function checkMissingNode(packages: string[], cwd: string): Promise<string[]> {
  const { spawn } = await import("node:child_process");
  // require.resolve throws if the module can't be resolved from the cwd.
  // Wrap each in try/catch and print the name on failure — one line per
  // missing package, easy to parse back.
  const program = packages
    .map(
      (p) =>
        `try { require.resolve(${JSON.stringify(p)}) } catch (e) { console.log(${JSON.stringify(p)}) }`
    )
    .join("\n");
  return new Promise<string[]>((resolve) => {
    const child = spawn("node", ["-e", program], { cwd, shell: false, windowsHide: true });
    let stdout = "";
    child.stdout?.on("data", (c) => { stdout += c.toString("utf-8"); });
    child.on("error", () => resolve(packages));
    child.on("exit", () => {
      const missing = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      resolve(missing);
    });
  });
}
