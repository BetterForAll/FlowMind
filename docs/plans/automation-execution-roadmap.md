# Automation Execution Roadmap

> **Handoff document.** This is the full context needed to pick up the
> automation-execution work in a fresh session. Read top-to-bottom; every
> section matters. The current session has reached context-limit territory,
> so further work should start from here.

## One-paragraph summary

FlowMind observes user behaviour, detects repeatable workflows, and (today)
generates static Python / Node.js scripts to automate them. The static
script approach has hit a hard limit: one-shot LLM-generated code can't
know the local environment (OneDrive-redirected Desktop, specific app
versions, window focus timing, search-vs-direct-URL patterns, etc.) and
fails on specifics that weren't visible in the observation. The user and
I agreed the right long-term shape is **agent-driven execution** — a Gemini
function-calling loop with real tools (HTTP, filesystem, subprocess,
Playwright, Windows UI Automation) that runs the flow step-by-step, reacts
to each result, and heals from errors. We're doing it in three stages, one
stage per future session:

1. **Self-healing scripts** — when a generated script fails, a `ScriptDoctor`
   agent reads the error + script and writes a patch. Incremental; reuses
   everything we have.
2. **Agent-first execution** — instead of generating a script and running
   it, run an agent loop directly. The script becomes a cache of the
   successful trace. Uses Gemini function calling + a stdlib tool set +
   Playwright for browser flows.
3. **Live desktop co-pilot** — "Claude Code but watching your desktop."
   The agent uses Windows UI Automation (`pywinauto` / `uiautomation`) and
   pyautogui as fallback to control native apps. Screenshot+vision for
   apps without accessibility info. User approves destructive steps.

## What's live today on `origin/main`

Full pipeline (as of commit `b774da0`):

```
Capture → Describe → Detect → PartialElevator → GapCloser → Matcher
   → WorthJudge → BodyRefiner → ParamExtractor → Save → UI
```

- **Capture**: screenshots + input events + audio + typed text (the
  keystroke capture fix from commit `9896bd5` is what makes the later
  stages actually work on dialog flows).
- **Describe** (phase 1, `src/engine/describe.ts`): Gemini narrates each
  ~1-minute window. Prompt now uses typed-text evidence for dialog-based
  steps (Save-As, filename typing).
- **Detect** (phase 2, `src/engine/flow-detection.ts`): Gemini reads all
  narratives from the run, outputs complete / partial / knowledge
  fragments. Prompt now has PARTIAL-TO-COMPLETE CHECK, ITERATIVE-SEARCH
  PATTERN, and REPEATED-PATTERN INSTANCES rules to prevent the
  "completed-but-classified-as-partial" bug.
- **PartialElevator** (`src/engine/partial-elevator.ts`): post-pass that
  re-examines each partial. If later windows show the outcome reached,
  promotes to complete.
- **GapCloser** (`src/engine/gap-closer.ts`): runs on existing on-disk
  partials using this-run's descriptions. Auto-answers gaps from
  observation. User interview is last resort.
- **Matcher** (`src/engine/evaluator.ts`): app-overlap-filtered Gemini
  call that decides save-new vs merge-into-existing. Within-run dupe
  collapse via union-find.
- **WorthJudge** (`src/engine/worth-judge.ts`): always-thinking-enabled
  classification into noise / partial-with-gaps / repeatable-uncertain /
  meaningful. Full phase-2 output fed in (no truncation). Noise is dropped
  — not saved.
- **BodyRefiner** (`src/engine/body-refiner.ts`): on merge, Gemini
  consolidates old stored body with new observation. Lossless on failure
  (returns old body unchanged).
- **ParamExtractor** (`src/engine/param-extractor.ts`): extracts dynamic
  variables (`subject`, `folder`, etc.) into `FlowFrontmatter.parameters`.
  On merge, fresh extraction merges with existing classification (user's
  manually set `kind` / `fixed_value` / `rule` is preserved).
- **UI** (`src/renderer/views/FlowDetail.tsx`): worth badge on Dashboard,
  "Judge's verdict" panel on detail, parameter cards with kind badges,
  Run/Install/Logs controls, stdin fallback panel, form-based parameter
  entry before Run.

## How a run works today (UI-side)

1. User opens a complete flow in FlowDetail.
2. Clicks the Python or Node.js tab.
3. Clicks **Run Automation**.
4. If the script declares CLI flags (detected by regex-scanning the
   script for `--name` tokens, falling back to `flow.parameters`): a form
   appears with one field per parameter. Descriptions + example values
   come from `flow.parameters` when names match (case-insensitive,
   dash/underscore-normalised compare).
5. User fills the form, clicks **Run with these values**.
6. `AutomationRunner.run(filePath, format, {params})` spawns python/node
   with the script path + `--name value` args + `FLOWMIND_PARAM_*` env
   vars. Script reads values via argparse / `process.argv`.
7. Output streams live into the panel; stdin input field is still there
   as a fallback for mid-run prompts (e.g., `--yes`-gated confirmations).
8. On exit, the run is saved to
   `~/flowtracker/automations/logs/<slug>-<format>/<format>-<iso>.log`
   and listed under **Previous runs** with status, duration, size.

## The concrete failure modes driving the roadmap

The bugs we hit in this session, which static scripts cannot structurally
solve, are the motivation for the agent-driven redesign:

1. **OneDrive-redirected Desktop** — script wrote `C:\Users\befre\Desktop\`,
   that folder doesn't exist on this machine (real desktop is
   `C:\Users\befre\OneDrive\Desktop\`). Script ENOENT'd. Static scripts
   have no way to discover this at write-time.
2. **Direct-title Wikipedia lookup vs search** — script assumed the
   subject maps directly to `en.wikipedia.org/wiki/<subject>`. Works for
   "Octopus"; fails for "claude design" which isn't a real article. The
   user's observed workflow was search-then-navigate, but the generator
   collapsed it to direct lookup.
3. **Parameter name drift** — the extractor said `subject`, the generator
   invented `articleSubject`, the form didn't match. Fixed partially by
   detecting params from script content at UI time, but the root cause is
   that extractor and generator are separate LLM calls with no coordination.
4. **Interactive prompts break the form flow** — old scripts used
   `input()`, which hangs the Run panel. Fixed by teaching the generator
   to use argparse instead. But the fix is fragile to LLM drift.

Each of these would be handled naturally by an agent: the agent would try
the path, see ENOENT, try `%OneDrive%\Desktop`, succeed. Would try direct
URL, get 404, fall back to search API. Would ask the user for a value
through a tool rather than hallucinating an argname.

## Stage 1 — Self-healing scripts (next session)

### Scope

One Gemini call wrapper: `ScriptDoctor`. When a script exits non-zero,
the `ScriptDoctor` receives:
- The script source
- stdout + stderr
- The exit code
- The flow's body + parameters
- The parameter values the user provided

It returns a patched script. The runner writes the patch to disk as a
versioned file (e.g., `script.v2.py`) — the original is preserved so the
user can diff / revert — and retries with the same params. Max 3 attempts
per run. Every attempt is recorded in the run log.

### Concrete implementation hints

- New module: `src/engine/script-doctor.ts`.
- Prompt structure: "this script was supposed to accomplish X [flow body],
  was invoked with params Y, failed with error Z. Analyse and produce a
  patched version. Return ONLY the new source."
- Validation: new script must have non-empty content, must be different
  from original, must still contain the parameter names (so the form-run
  loop stays aligned).
- UI: on script failure, the output panel gets an **"Auto-fix and retry"**
  button. The button is always visible; auto-running the fixer without
  user consent is wrong (it modifies user-owned files).
- Permission: the doctor writes to `~/flowtracker/automations/<slug>-<fmt>.v<N>.<ext>`
  rather than overwriting the primary file. After success, the fixed
  version can be promoted to primary on explicit user action.
- Logging: every patch attempt adds an entry to the run log under
  `# retry_attempt: N` with the error message that triggered it.

### Files to touch

- **New**: `src/engine/script-doctor.ts`.
- **Modified**: `src/engine/automation-runner.ts` — on exit event with
  non-zero code, if `autoFixEnabled` and retries left, invoke doctor.
- **Modified**: `src/main.ts` — new IPC: `automations:autoFixAndRetry`.
- **Modified**: `src/preload.ts` — bridge method.
- **Modified**: `src/renderer/views/FlowDetail.tsx` — Auto-fix button,
  retry attempt counter in status line, diff viewer (optional).

### Success criteria

The OneDrive-Desktop test: generate a script that uses `~/Desktop`, run
it, get ENOENT, click Auto-fix, retry, script succeeds writing to the
OneDrive path. Without manual intervention.

## Stage 2 — Agent-first execution (second session from handoff)

### Scope

Replace "generate script, then run" with "agent executes the flow using
tools; trace is saved as a script for reuse." The script becomes a cache
of a known-good execution path, not the primary artifact.

### Tool set to expose to the agent

All Node.js-implemented in the main process, Gemini calls them via
function-calling:

- **Filesystem**: `read_file(path)`, `write_file(path, content)`,
  `list_dir(path)`, `delete_file(path)` (explicit opt-in), `home_dir()`,
  `desktop_dir()` (returns OneDrive-resolved real Desktop on Windows),
  `documents_dir()`, `temp_dir()`.
- **HTTP**: `http_get(url)`, `http_post(url, body, headers?)`,
  `download_file(url, dest)`. Use Node's built-in `fetch`.
- **Subprocess**: `run_command(cmd, args, options)` — for `pip install`,
  `git`, `curl` fallback, etc.
- **Browser (Playwright)**: `browser_open(url)`, `browser_click(selector|text)`,
  `browser_type(selector, text)`, `browser_wait_for(selector)`,
  `browser_screenshot()`, `browser_extract_text(selector)`,
  `browser_close()`.
- **User interaction**: `ask_user(prompt, kind: "text" | "yesno" | "choice")`
  — bridges to the existing UI to get a value. Re-uses the form/stdin
  infrastructure.
- **Flow metadata**: `recall_observation(step_description)` — returns the
  relevant slice of the flow body for the step the agent is working on,
  so the agent has the user's observed intent in front of it.

### Agent loop shape

```typescript
class AgentExecutor {
  async execute(flow: FlowDocument, params: Record<string, string>) {
    const messages = [
      { role: "system", parts: [AGENT_SYSTEM_PROMPT] },
      { role: "user", parts: [this.buildFlowContext(flow, params)] },
    ];
    const trace: ToolCall[] = [];
    for (let i = 0; i < MAX_STEPS; i++) {
      const response = await this.genai.generateContent({
        contents: messages,
        tools: [{ functionDeclarations: TOOL_DECLS }],
      });
      if (response.finishReason === "STOP") return { trace, done: true };
      for (const call of response.functionCalls) {
        const result = await this.invokeTool(call.name, call.args);
        trace.push({ call, result });
        messages.push({ role: "model", parts: [{ functionCall: call }] });
        messages.push({ role: "user", parts: [{ functionResponse: result }] });
      }
    }
    return { trace, done: false, reason: "max steps" };
  }
}
```

### Script synthesis from trace

After a successful agent run, the trace is a known-good sequence of tool
calls with concrete values. Convert to a script by translating each tool
call back to its language equivalent:
- `http_get(url)` → `urllib.request.urlopen(url).read()` in Python
- `write_file(path, content)` → `Path(path).write_text(content)`
- `browser_click(selector)` → Playwright equivalent
- `ask_user(...)` → argparse arg OR a form-based run-time value

The synthesis call is a straightforward Gemini prompt: "given this
successful execution trace and these parameter values, write a
self-contained script that reproduces it."

### Files to touch

- **New**: `src/engine/agent-executor.ts`, `src/engine/agent-tools.ts`,
  `src/engine/script-synthesizer.ts`.
- **Modified**: `src/main.ts` — new IPC for agent execution, tool-call
  forwarding so the browser and ask_user tools can reach the renderer.
- **Modified**: `src/renderer/views/FlowDetail.tsx` — agent-mode toggle on
  the Run button, live trace display.

### Success criteria

Run the Wikipedia research flow without ever having generated a script.
Agent searches, navigates, extracts, saves. Trace is recorded. Save as
script. Next run can use script (fast) or agent (fresh).

## Stage 3 — Live desktop co-pilot (third session from handoff)

### Scope

Extend the agent's tool set to include **Windows UI Automation** for
native apps and **screenshot + vision** for apps with no accessibility
info. Add a real-time UX where the user sees what the agent is about to
do and can approve / reject each step.

### Why this is tractable

- `pywinauto` or `uiautomation` gives semantic control over any Windows
  app that exposes accessibility — which is essentially all of them in
  2025 (Office, Chrome, File Explorer, Notepad, VS Code, all Electron
  apps).
- For the remaining few apps without accessibility info, take a
  screenshot, send to Gemini Pro (vision), ask "where is the X button",
  get coordinates, pyautogui to click. This is the Anthropic
  Computer-Use / OpenAI Operator pattern — works today.
- Real obstacles are narrow and well-understood: UAC prompts, secure
  desktop, DRM-protected apps, certain games. Explicitly out of scope.

### Tool additions

- `window_list()` — enumerate open windows with their automation IDs.
- `window_focus(title|id)` — bring a window to foreground.
- `app_launch(path)` — spawn an app (File Explorer, Notepad, etc.).
- `control_find(window, {name?, role?, automation_id?})` — locate a
  specific control.
- `control_click(control)`, `control_type(control, text)`,
  `control_value(control)`.
- `screen_screenshot()` + `vision_locate(description, screenshot)` —
  the fallback-via-vision path.
- `keyboard_send(keys)` — `{Enter}`, `{Ctrl+S}`, etc.
- Safety wrapper: every destructive action goes through
  `confirm_with_user(action, reason)` before executing unless the flow
  has been marked "trusted" (user's explicit opt-in, per flow).

### UX additions

- Agent-execution pane — replaces the output panel when agent mode is
  on. Shows tool-call-by-tool-call what the agent is doing, with live
  screenshots for browser / desktop tools.
- Step approval — user can enable "approve each step" mode for unknown
  flows. Each tool call waits for a thumbs-up.
- Interrupt button — kill the agent mid-execution cleanly.

### Real obstacles and how we handle them

- **UAC prompts**: the agent cannot click them. Flag the flow as
  requiring admin pre-launch; tell the user up front.
- **MFA / captcha**: `ask_user` tool pauses and waits for the user to
  complete the challenge; agent resumes after.
- **App version changes breaking control IDs**: the agent retries with
  different locator strategies (name → role → automation-id →
  vision-locate) before giving up.
- **Safety**: any file deletion, any outgoing message, any financial
  transaction requires explicit per-step approval the first N times,
  graduating to a trust level set by the user per flow.

## Stack dependencies

Stage 1: no new deps (all Gemini).

Stage 2:
- `playwright` (npm) — browser automation. Installed via
  `npm install playwright` + `npx playwright install chromium`.
- `@google/genai` function calling is already in use — no new version
  needed.

Stage 3 (mostly Python-side via the user's Python install, invoked via
`run_command` tool — our main process stays Node):
- `pywinauto` — semantic Windows UI automation. `pip install pywinauto`.
- `uiautomation` — alternative that uses MS UIA directly. `pip install
  uiautomation`.
- `pyautogui` — screenshot + coordinate clicks fallback. `pip install
  pyautogui pillow`.
- Vision fallback uses Gemini 2.5 Pro (multimodal), already configured.

## Non-goals

What I've decided NOT to try, in case a future session is tempted:

- **Cross-session automation** (running automations when FlowMind isn't
  the foreground app) — too dangerous, would need privileged process.
- **Keystroke capture for live replay** — the keystroke capture for
  observation already works; live replay via keyboard hooks would
  conflict with the user's real input during execution.
- **Cloud-hosted execution** — all automation runs locally on the user's
  machine; this is a feature, not a bug. Cloud introduces privacy issues
  and latency.

## Session-specific context you won't find in code

- **User preference**: autonomous execution, commit-per-step,
  reversibility, no "bury the lead" summaries. Detailed in memory at
  `C:\Users\befre\.claude\projects\c--Users-befre-Documents-Code-FlowTracker\memory\feedback_autonomous_execution.md`.
- **Active account for git push**: `BetterForAll` (not `Igor-Ann`).
  Switch with `gh auth switch --user BetterForAll` if pushes 403.
- **Commit style**: feat/fix/refactor/docs/chore prefix. Multi-paragraph
  body explaining the WHY, not just the what. Co-Authored-By line at
  the end: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **Testing posture**: no mocks of real systems. When the user asks
  "test this", give them the shortest repro path against the real app,
  not a unit test.
- **Noise drop is intentional**: if WorthJudge says a flow is noise, it
  must be dropped, not saved-with-warning. The judge is our primary
  quality gate.

## Where to start in the next session

1. Read this file top to bottom.
2. Read `src/engine/flow-detection.ts` — it's the pipeline spine.
3. Check `git log --oneline -25` — the last 25 commits map 1:1 to the
   sessions's work and explain design decisions.
4. Pick Stage 1 (self-healer) and execute. It's the smallest
   next-action: ~1 hour of focused work, zero new packages, builds
   directly on `AutomationRunner`.
5. Report back with commits, don't ask permission mid-stream.
