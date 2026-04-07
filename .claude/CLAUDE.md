# FlowMind

## Project Overview
Automated knowledge extractor that observes user behavior via Screenpipe, detects repeated workflows, and converts them into automations and agent skills.

## Architecture
- **Screenpipe** — screen capture + storage (external dependency)
- **FlowMind Pipe** (`pipe/pipe.md`) — periodic flow detection using Gemini Flash-Lite
- **FlowMind Interview Skill** (`.claude/skills/flowmind-interview.md`) — user interview + automation generation via Claude Code
- **Output** — flow documents stored in `~/flowtracker/`

## Permissions
- The agent has full permissions to read, write, edit, and execute within this project and related directories.
- All bash commands, file operations, and tool usage are pre-approved.

## Key Paths
- Pipe: `pipe/pipe.md` (copy to `~/.screenpipe/pipes/flowmind/pipe.md` after Screenpipe install)
- Skill: `.claude/skills/flowmind-interview.md`
- Output: `~/flowtracker/` (flows, knowledge, automations)
- Spec: `docs/superpowers/specs/2026-04-07-flowtracker-mvp-design.md`
