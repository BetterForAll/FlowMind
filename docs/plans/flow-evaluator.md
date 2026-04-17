# Flow Evaluator — Plan

Status: active. Matcher is landed (commits 449b1fa → 91c987a). Classify and
Gap-close are the remaining scope.

## What the evaluator is, actually

A single pass that runs AFTER phase-2 detection and BEFORE saving. It has
three responsibilities. Earlier work mistakenly scoped the evaluator to
only the first one, hence this rewrite.

### (a) Match  (landed 2026-04-17 — commits 449b1fa..91c987a)

"Is this newly-detected flow the same workflow as an existing one?" →
merge evidence (occurrences++, last_seen=now, union source_windows, union
apps) or save as new. Includes within-run duplicate collapse.

Gemini call: yes. Model: inherits detectionModel. Pre-filter: app-overlap.

### (b) Gap-close  (NEW — not yet built)

For each **existing partial flow** with open interview questions, examine
the new descriptions from THIS run and ask: do these observations provide
evidence that answers any open gap? If yes, auto-answer the gap without
bothering the user.

After closing gaps autonomously:
- If all gap questions are now answered → promote the partial to complete
  (reusing the existing `promoteToComplete` path via FlowStore).
- If some remain → update the partial with answered gaps marked, leaving
  the unanswered ones for the user.

The user's manual interview flow becomes the LAST RESORT, not the first.
Whenever the system can fill a gap from observation, it must do so
silently.

Gemini call: yes — separate call with its own prompt. Input: the partial
flow's body (with gap markers + questions) + the new descriptions'
narratives. Output: `{ answered: [{index, answer, evidence}], unanswered:
[indices] }`.

### (c) Classify worthiness  (NEW — not yet built)

For every flow emitted this run (new OR merged-into), attach:

- `worth: "noise" | "partial-with-gaps" | "repeatable-uncertain" | "meaningful"`
- `worth_reason: string`   — one sentence explaining the tier
- `time_saved_estimate_minutes: number`   — per-run savings × expected
  future occurrences. Rough formula: `avg_duration_minutes × (max(occurrences, 3) - 1)`
  where the `-1` represents the automation's own runtime and `max(..., 3)`
  is a floor reflecting our belief that a flow detected once will likely
  recur.

Tier definitions:
- **noise**: user activity that isn't a repeatable workflow (jumping
  between YouTube videos, general browsing, reading news, opening/closing
  apps without producing an outcome). Do NOT save as a flow file — drop
  entirely, or downgrade to a knowledge fragment if there's any
  observation worth preserving.
- **partial-with-gaps**: pattern has shape but steps are unclear /
  missing. This is the today's `partial-flow` type. Worth only assigned
  after gap-close has run.
- **repeatable-uncertain**: reproducible but unclear automation payoff —
  maybe the steps are simple enough to do manually, or the trigger isn't
  routine.
- **meaningful**: clear trigger, reproducible steps, real outcome, likely
  to recur. Prime automation candidate.

Gemini call: yes — separate call (the prompt is small and self-contained,
the model can focus on judgment without also producing step markdown).
Input: the flow (name, trigger, steps, apps, occurrences, avg_duration).
Output: `{ worth, worth_reason, time_saved_estimate_minutes }`.

## Order of work

1. **Classify first** — smallest, most self-contained addition. Only
   needs new frontmatter fields and a new module. Zero dependency on
   gap-close.
2. **Gap-close second** — reuses the description pool infrastructure and
   the existing partial-flow body format.
3. **(Follow-up, not this pass)** — Dashboard UI surface for `worth` and
   time-saved estimate (sort/filter/group, hide noise).

## Files

- **New:** `src/engine/worth-judge.ts` — `WorthJudge.classify(flow)` →
  `{ worth, worth_reason, time_saved_estimate_minutes }`. Stateless, one
  Gemini call per flow.
- **New:** `src/engine/gap-closer.ts` — `GapCloser.close(partialFlow,
  newDescriptions)` → `{ answered: [...], unanswered: [...] }`. Stateless,
  one Gemini call per partial flow with open gaps.
- **Modified:** `src/types.ts` — extend `FlowFrontmatter` with `worth`,
  `worth_reason`, `time_saved_estimate_minutes`. All optional so existing
  flows on disk remain valid without migration.
- **Modified:** `src/engine/flow-detection.ts`
  - After the matcher decides "new" vs "merge", run WorthJudge on each
    surviving flow. If worth === "noise", skip saving (or downgrade to
    knowledge — MVP just skips).
  - Before the matcher's loop, run GapCloser on every existing partial
    flow against the current run's descriptions. Any newly-answered gaps
    either promote the partial to complete (via an existing-partial-flow
    update path) or persist back to the partial with the answered gaps
    recorded.
- **Modified:** `src/engine/flow-store.ts` — `updateFlow` already exists;
  we'll add a small helper `promotePartialToComplete(filePath,
  completeBody)` to encapsulate the current logic that lives in
  `InterviewEngine`, so both the UI interview and the autonomous
  gap-closer can use it without duplication.

## Decisions and why

- **Three separate LLM calls, not one blob.** Each has a focused prompt,
  independent cost/latency, and independent failure isolation. Today's
  matcher already follows this pattern; classify + gap-close continue it.
- **Classify AFTER match, not before.** The matcher may merge N new
  flows into existing ones; we want to score only the surviving flows,
  not waste tokens on flows that will be absorbed anyway. For merged
  flows, we re-score the TARGET of the merge (to reflect the new
  occurrences count and updated time-saved estimate).
- **Gap-close BEFORE matcher, operating on EXISTING partials.** Gap-close
  reads THIS run's descriptions, not this run's detected flows — its job
  is to update what's already on disk. It runs early so that a partial
  promoted to complete this run can participate in the matcher as a new
  complete flow (not as a still-partial).
- **Noise is dropped, not quarantined.** No "noise bin" folder. If the
  classifier says noise, we don't save — simplest possible. If the phase-2
  prompt leaked the flow out, the worst case is a missed save, which is
  better than polluting the flow library. The source descriptions still
  exist; if we were wrong, we can replay.
- **Time-saved is deliberately rough.** `avg_duration × (max(occurrences,
  3) - 1)` is a 30-second decision, not a forecasting model. It's useful
  as a relative ranking signal, not an absolute promise. The "-1"
  acknowledges the automation itself takes some time.
- **Existing on-disk flows stay unscored.** New/scored fields are
  optional in the frontmatter parser. Unscored flows show up in the UI
  as "unclassified" when we build that surface. No migration pass.

## Failure isolation

Every new LLM call catches + falls back the same way the matcher does:
- WorthJudge throws → treat flow as "repeatable-uncertain" (neutral), no
  time-saved estimate. Save as normal.
- GapCloser throws → treat every gap as unanswered. Partial flow
  unchanged. No regression vs. today.

## Out of scope

- Dashboard UI for `worth` and time-saved.
- Re-scoring older flows in a background job.
- "Noise bin" quarantine — simple drop.
- Using gap-close to infer new steps the user never performed (only
  closing gaps the partial already flagged).
