# Backlog

Features we want to build later, not now.

## Flow deduplication / merging

**Problem:** Every detection run creates a new flow file, even when the same workflow was already detected in a previous run. `flows/complete/` accumulates near-duplicates ("Wikipedia Article Snippet Extraction" from Monday and "Wikipedia Paragraph to Notes File" from Tuesday are the same thing but live as separate files). The data model has `occurrences` and `last_seen` fields for this purpose, but the code never uses them — they're always `1` and equal to `detected`.

**Desired behavior:** when phase 2 detects a flow, it should compare against existing flows. If the new detection is the same workflow as an existing one, update the existing file: increment `occurrences`, bump `last_seen`, merge `source_windows`, optionally refine steps based on new evidence. Only save as a new file when genuinely distinct.

**Approach when we build it:**
Add a dedup pass inside `FlowDetectionEngine.detectFlows()`, after phase 2 returns but before `saveResults`. Load existing complete flows, add their names+steps to the phase-2 prompt (or a dedicated second call), and ask the model to classify each newly detected flow as "new" or "matches existing flow X". Merge accordingly in `saveResults`.

**Files that will change:**
- `src/engine/flow-detection.ts` — add dedup pass, wire `updatedComplete` counter
- `src/engine/flow-store.ts` — add `updateFlowFrontmatter` helper for merging occurrences/source_windows
- Possibly a new prompt or a new field in the existing detection prompt

**Not doing now because:** core pipeline is still being validated. Duplicates are ugly but not broken. Manual cleanup from the UI works for now.
