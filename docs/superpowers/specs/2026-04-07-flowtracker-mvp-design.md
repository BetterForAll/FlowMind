# FlowTracker MVP Design Spec

**Date:** 2026-04-07
**Status:** Approved
**Scope:** MVP — Screenpipe Pipe + Claude Code Skill

---

## 1. Problem Statement

Users repeat workflows daily (email triage, data entry, report generation, trading routines) without realizing how much time they spend on automatable tasks. There is no tool that passively observes user behavior, detects repeated flows, captures decision-making knowledge, and converts that into executable automations or agent skills.

## 2. Vision

An automated zero-effort knowledge extractor that:

1. **Observes** — captures everything the user does on their computer
2. **Understands** — detects repeated workflows and decision patterns
3. **Learns** — identifies gaps in understanding and interviews the user to fill them
4. **Creates** — generates automations, skills, scripts, or documentation from complete flows

## 3. MVP Scope

The MVP consists of **two markdown files** — no application code:

1. **A Screenpipe Pipe** (`pipe.md`) — periodic flow detection from screen data
2. **A Claude Code Skill** (`flowtracker-interview.md`) — user interview + automation generation

### What the MVP does NOT include:

- No custom UI or desktop app
- No persistent database (flows stored as flat files)
- No cross-session pattern detection (each Pipe run analyzes one time window)
- No automatic automation execution (human reviews everything)

## 4. Architecture

```
┌─────────────────────────────────┐
│ Screenpipe (existing, installed)│
│  - captures screen, OCR, audio  │
│  - stores in local SQLite       │
│  - REST API on localhost:3030   │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ FlowTracker Pipe (pipe.md)      │
│  - runs every 60 min            │
│  - queries last hour of data    │
│  - sends to Gemini Flash-Lite   │
│  - detects flows & knowledge    │
│  - saves to ~/flowtracker/      │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ ~/flowtracker/                  │
│  ├── flows/                     │
│  │   ├── complete/              │
│  │   └── partial/               │
│  ├── knowledge/                 │
│  └── automations/               │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│ Claude Code Skill               │
│  - reads flow documents         │
│  - interviews user about gaps   │
│  - generates automations/skills │
└─────────────────────────────────┘
```

### Dependencies

| Component | Role | License |
|-----------|------|---------|
| Screenpipe | Screen capture + storage + Pipe execution | MIT (open source) |
| Gemini 2.5 Flash-Lite API | AI analysis of screen data | Pay-per-use ($0.10/1M input tokens) |
| Claude Code | User interview + automation generation | Existing tool (user already has it) |

## 5. Component 1: FlowTracker Pipe

### Location

`~/.screenpipe/pipes/flowtracker/pipe.md`

### Schedule

Runs every 60 minutes.

### Behavior

1. Query Screenpipe API for the last 60 minutes of screen data (OCR text, window titles, app names, timestamps)
2. Send the data to Gemini 2.5 Flash-Lite with the flow detection prompt
3. AI analyzes the data and classifies output into:
   - **Complete flows** — all steps and conditions detected
   - **Partial flows** — steps detected but with gaps, includes interview questions
   - **Knowledge fragments** — behavioral observations and decision patterns
4. Save each output as a markdown file in `~/flowtracker/`

### AI Provider

- **MVP default:** Gemini 2.5 Flash-Lite (cheapest vision-capable model)
- **Design:** Provider-agnostic. The prompt defines the output format. Swapping providers means changing the API call, not the logic.

### Output Directory Structure

```
~/flowtracker/
├── flows/
│   ├── complete/
│   │   └── 2026-04-07-email-triage.md
│   └── partial/
│       └── 2026-04-07-invoice-processing.md
├── knowledge/
│   └── 2026-04-07-pre-trade-research-pattern.md
└── automations/
    └── (generated later by Claude Code skill)
```

### File Naming Convention

`YYYY-MM-DD-<slug>.md` where slug is a kebab-case summary of the flow name.

If the same flow is detected again, the existing file is updated (occurrence count incremented, new variations noted) rather than creating a duplicate.

## 6. Output Document Formats

### 6.1 Complete Flow

```markdown
---
type: complete-flow
id: flow-<uuid>
name: <human-readable name>
detected: <ISO date first detected>
last_seen: <ISO date last observed>
occurrences: <count>
confidence: high | medium
avg_duration: <minutes>
trigger: <what starts the flow — time-based, event-based, manual>
apps: [list of apps involved]
---

# <Flow Name>

## Trigger
<What starts this flow — e.g., "weekday mornings 8:00-8:30" or "when a new email arrives from X">

## Steps
1. <Step description>
2. IF <condition>:
   a. <sub-step>
   b. <sub-step>
   ELSE:
   a. <alternative sub-step>
3. FOR EACH <item>:
   a. <repeated step>
4. <Step that uses external data — note the data source>

## Decision Logic
- <condition name>: <how the user decides — e.g., "urgent = deadline within 24h">
- <condition name>: <criteria>

## Tools & Data Sources
- <App/service>: <how it's used — read/write/both>
- <External data>: <what data is needed, from where>

## Automation Classification
- Deterministic steps: <list step numbers>
- AI-required steps: <list step numbers + why AI is needed>
- Human-approval-required steps: <list step numbers + why — e.g., involves money>

## Variations Observed
- <variation description>
```

### 6.2 Partial Flow

```markdown
---
type: partial-flow
id: flow-<uuid>
name: <human-readable name>
detected: <ISO date>
last_seen: <ISO date>
occurrences: <count>
confidence: low | medium
gaps: <number of gaps>
apps: [list of apps involved]
---

# <Flow Name> (Partial)

## Observed Steps
1. <Step description>
2. <Step description>
3. [GAP] <What was observed but not understood>
4. <Step description>

## Questions to Complete This Flow
- Q1: <specific question about a gap>
- Q2: <specific question about a decision>
- Q3: <specific question about a condition>

## What I Think Is Happening
<AI's best guess at the complete flow, marked as uncertain>
```

### 6.3 Knowledge Fragment

```markdown
---
type: knowledge
id: knowledge-<uuid>
detected: <ISO date>
category: decision-pattern | habit | preference | tool-usage
apps: [list of apps involved]
---

# <Observation Title>

## Observation
<What was observed — e.g., "User always checks X before doing Y">

## Potential Significance
<Why this might matter for automation — e.g., "This suggests a decision checklist
that could be partially automated">

## Related Flows
- <flow ID or name, if this observation relates to a detected flow>
```

## 7. Component 2: Claude Code Skill

### Location

`~/.claude/skills/flowtracker-interview.md` (or project-level `.claude/skills/`)

### Behavior

When invoked, the skill:

1. **Scan** — reads all documents in `~/flowtracker/`
2. **Summarize** — shows the user a dashboard:
   - N complete flows ready for automation
   - N partial flows needing interview
   - N knowledge fragments
3. **Interview** (for partial flows):
   - Presents the observed steps
   - Asks gap questions one at a time
   - Updates the document with answers
   - Promotes partial flow to complete flow when all gaps are filled
4. **Generate** (for complete flows):
   - Asks the user what to create:
     - Claude Code skill (`.md` file)
     - Python automation script
     - Node.js automation script
     - Step-by-step tutorial/documentation
   - Generates the requested output
   - Saves to `~/flowtracker/automations/`
5. **Cross-reference** — uses knowledge fragments to enrich flow understanding

### Output Types

The skill can generate:

| Output | Format | Where it's saved |
|--------|--------|-----------------|
| Claude Code skill | `.md` | `.claude/skills/` |
| Python script | `.py` | `~/flowtracker/automations/` |
| Node.js script | `.js` | `~/flowtracker/automations/` |
| Tutorial | `.md` | `~/flowtracker/automations/` |

## 8. AI Provider Strategy

### MVP

Gemini 2.5 Flash-Lite for the Pipe (flow detection from screen data). Claude for the skill (interview + code generation — already available via Claude Code).

### Provider-Agnostic Design

The Pipe prompt defines the **output format** (the document schemas above), not the model. Any vision-capable model can be used. Switching providers requires changing only the API call configuration, not the prompt or output parsing.

### Cost Estimate (MVP)

Assuming 8 hours of screen capture per day, 1 Pipe run per hour:

- ~8 API calls/day to Gemini Flash-Lite
- Each call: ~2-5K tokens input (OCR text + window titles), ~1-2K tokens output
- Estimated daily cost: **< $0.01/day**

## 9. Future Stages (not built in MVP)

### Stage 2: Standalone App

- Replace Claude Code skill with an app built on Claude Agent SDK
- Automated interviews (scheduled, not manual)
- Simple UI for managing flows and viewing detected patterns
- Cross-session pattern detection (track flows across days/weeks)
- Persistent SQLite database for flow history

### Stage 3: Full Product

- Possibly replace Screenpipe with own capture layer (full independence)
- Desktop app with system tray
- Auto-start on boot
- Real-time flow detection (not hourly batches)
- Automation marketplace / sharing
- Team features

## 10. Success Criteria for MVP

The MVP is successful if:

1. The Pipe correctly identifies at least 3 real repeated workflows from a day of screen capture
2. The flow documents are accurate enough that a human reading them says "yes, that's what I do"
3. Partial flows have meaningful questions that, when answered, complete the flow
4. The Claude Code skill can take a complete flow and generate a working automation script

## 11. Getting Started

### Prerequisites

1. Install Screenpipe — https://docs.screenpi.pe/getting-started
2. Have a Gemini API key
3. Have Claude Code installed

### Setup Steps

1. Install Screenpipe and let it run for at least 1 day to accumulate data
2. Create the Pipe: copy `pipe.md` to `~/.screenpipe/pipes/flowtracker/`
3. Create the output directory: `mkdir -p ~/flowtracker/{flows/complete,flows/partial,knowledge,automations}`
4. Install the Claude Code skill: copy `flowtracker-interview.md` to `.claude/skills/`
5. Wait for the Pipe to run (or trigger manually)
6. Open Claude Code and invoke the FlowTracker Interview skill to review detected flows
