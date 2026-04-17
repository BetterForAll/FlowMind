# Flow Evaluator — Plan

Status: active, about to implement.

## Goal

Stop accumulating duplicate flows. When phase 2 detects a flow that matches
one already on disk, update the existing flow (bump `occurrences`, `last_seen`,
union `source_windows` and `apps`) instead of writing a new file.

This is active issue #1 from the session plan — "Evaluator pass + auto-resolver",
re-scoped to emphasize cross-session matching (Level 2) as the load-bearing
capability. Level 1 (within-run dedupe) is a cheap sanity check bolted onto
the same call.

## Design decisions and why

### Separate Gemini call (not inline in the phase-2 prompt)

The phase-2 detection prompt is already dense (classify complete/partial/
knowledge, produce step markdown, cite `source_windows`, merge adjacent
windows). Adding existing-flow comparison alongside would:

- bloat the prompt linearly with the flow library,
- degrade the primary detection task (mixed-task penalty), and
- prevent running matching on a cheaper model.

A separate call lets us use Flash-Lite for matching, iterate on the matching
prompt independently of detection, and fall back safely if the evaluator
fails.

### Level 2 is primary, Level 1 is secondary

Within-run dupes are already mostly handled by the phase-2 prompt's
"MERGE adjacent windows" rule. Cross-session matching is the part that
doesn't exist anywhere today and the part that makes the app feel
"not forgetful". So the evaluator call is Level-2-first; the Level-1
check runs in the same call because the newly-detected flows are already
in memory.

### Merge policy: metadata-only on MVP

On merge we update:

- `occurrences` → `+1`
- `last_seen` → `now`
- `source_windows` → union + dedupe
- `apps` → union + dedupe

We do NOT change `name`, `id`, `confidence`, or the markdown body. Body
refinement (picking better step text from the new detection) is a
follow-up — it has its own failure modes (we could overwrite a good
description with a worse one) and the metadata-only merge is enough to
kill the visible duplication today.

### Filter by app overlap before sending to the evaluator

To keep the prompt bounded as the library grows, include existing flows
only if they share at least one app with any newly-detected flow. A flow
that uses Slack + Chrome can't be the same workflow as a flow that uses
Excel + Outlook, so we don't pay tokens to ask.

### Failure isolation

If the evaluator call throws, returns malformed JSON, or times out, fall
back to "save all as new" — exactly today's behaviour. A warning is logged.
No detection regression from adding this step.

## Files

- **New:** `src/engine/evaluator.ts` — `FlowEvaluator` class, single public
  method `evaluate(newlyDetected, existingComplete)`.
- **Modified:** `src/engine/flow-detection.ts`
  - Construct a `FlowEvaluator` alongside `this.store`.
  - In `detectFlows()`, after `analyzeWithGemini`, load existing complete
    flows and call `evaluator.evaluate(...)`.
  - Pass the decisions into a modified `saveResults(...)`.
- **Modified:** `src/engine/flow-store.ts`
  - New helper `mergeFlow(existingFilePath, mergeFields)` that re-serializes
    the existing file with updated frontmatter.
  - The helper MUST NOT touch the body. Callers who want body refinement
    will replace the body explicitly.
- **Modified:** `src/types.ts`
  - Add `EvaluatorDecision` and `EvaluatorResult` types. No change to
    `FlowFrontmatter` or `DetectionResult` (already has `updatedComplete`).

## Prompt shape (draft)

```
You are FlowMind's evaluator. You compare newly-detected workflow flows
against flows already on record, and decide whether each new flow is the
same as an existing one or is genuinely new.

Two flows are the SAME workflow when they:
- accomplish the same user goal (e.g. "save an article to a topic folder"),
- use overlapping apps and a similar sequence of actions,
- would be described by the user as "the same thing I do regularly".

Two flows are DIFFERENT when:
- the goal differs (e.g. "bookmark" vs "save as pdf"),
- the apps are different ecosystems,
- the steps are structurally different even if some actions overlap.

Small variations in content (different article, different folder name) do
NOT make flows different — those are parameters of the same workflow.

Respond with ONLY valid JSON:
{
  "complete": [
    { "index": 0, "kind": "new" | "merge",
      "matchedFlowId": "<id when merge>",
      "reason": "<1 sentence>" }
  ],
  "within_run_dupes": [
    { "indexA": 0, "indexB": 2, "reason": "..." }
  ]
}

...then existing-flows list and newly-detected list...
```

## Reversibility

Each step below is its own commit so `git revert <sha>` undoes it cleanly:

1. Add `EvaluatorDecision` / `EvaluatorResult` types.
2. Add `FlowEvaluator` class with no wiring.
3. Add `FlowStore.mergeFlow()` helper.
4. Wire evaluator into `FlowDetectionEngine.detectFlows()`.
5. (Follow-up, separate work) body refinement on merge.

If any step misbehaves in practice, revert only that commit — earlier
commits remain useful.

## Out of scope for this pass

- Body refinement on merge (the markdown of the flow).
- Merging partial flows into existing complete flows (risky — partials
  are gap-annotated and need an interview; merging would drop questions).
- Evaluator UI — there is no user-facing view of merge decisions yet.
  Decisions appear only in logs and in the run summary counts.
