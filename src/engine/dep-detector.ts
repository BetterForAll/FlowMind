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
