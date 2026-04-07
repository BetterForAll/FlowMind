# FlowMind — Session Handoff

## What is FlowMind?
An automated knowledge extractor that runs in background, captures everything the user does (screenshots, mouse, keyboard, window titles, audio), detects repeated workflows using AI, and converts them into automations/skills.

## Repo
- GitHub: https://github.com/BetterForAll/FlowMind
- Local: c:\Users\befre\Documents\Code\FlowTracker

## Key Files
- **Implementation plan**: `.claude/plans/whimsical-juggling-hopcroft.md` — FULL plan with 5 phases, architecture, all details
- **Design spec**: `docs/superpowers/specs/2026-04-07-flowtracker-mvp-design.md` — original spec (references Screenpipe, but flow document formats are still valid)
- **Claude Code skill**: `.claude/skills/flowmind-interview.md` — interviews user about gaps in detected flows, generates automations
- **Screenpipe pipe reference**: `docs/reference/screenpipe-pipe-reference.md` — the analysis prompt to port to Electron app
- **Gemini API key**: `.env` (already set)
- **package.json**: written but `npm install` NOT yet run

## Current Status: Phase 1, Step 2

Phase 1 step 1 is done (old pipe moved to docs/reference). Next:
- Run `npm install` to install dependencies
- Note: `active-win` and `uiohook-napi` were removed from package.json by the user — need to be re-added (they require native compilation, may need special handling with Electron)
- Set up Electron Forge with Vite + TypeScript
- Create project structure under `src/`
- Get blank window + tray icon running

## Architecture (no Screenpipe)

```
Electron App (main process)
├── CaptureOrchestrator
│   ├── ScreenshotCapture (Electron desktopCapturer)
│   ├── InputCapture (uiohook-napi — keyboard + mouse)
│   ├── WindowTracker (active-win)
│   └── AudioCapture (MediaRecorder, opt-in)
├── StorageManager (JSONL + JPEG + WebM → ~/flowmind-data/)
├── SessionManager (auto-segment by idle 5min / time 60min)
└── AnalysisPipeline (Gemini 2.5 Flash-Lite, batch every 60min)

Renderer
├── Dashboard (Start/Stop, live stats)
└── Settings (audio toggle, intervals, API key, deny list)

Output → ~/flowtracker/ (markdown flow documents)
```

## Important Decisions Made
1. NO Screenpipe dependency — build own capture in Electron
2. Cross-platform from day one (Windows + Mac + Linux)
3. Provider-agnostic AI with adapter pattern, start with Gemini Flash-Lite (cheapest)
4. Screenshots on meaningful events (clicks, Enter), not continuous
5. Audio capture is opt-in toggle
6. JSONL for events, JPEG for screenshots, WebM for audio
7. System tray + minimal dashboard UI

## To Continue
```
Execute the FlowMind plan at .claude/plans/whimsical-juggling-hopcroft.md
Pick up from Phase 1 step 2. Work autonomously through all phases.
```
