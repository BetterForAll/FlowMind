// Flow document types matching the spec's output formats

/**
 * Worthiness tier assigned by the classifier. Guides UI surface (sort/filter,
 * hide noise) and the interview/automation priority.
 * - "noise": not a repeatable workflow. Should not be saved as a flow.
 * - "partial-with-gaps": pattern exists but steps/decisions are unclear.
 * - "repeatable-uncertain": reproducible but uncertain automation payoff.
 * - "meaningful": clear trigger, reproducible steps, real outcome — prime
 *   automation candidate.
 */
export type FlowWorth = "noise" | "partial-with-gaps" | "repeatable-uncertain" | "meaningful";

/**
 * How a parameter's value is decided at automation time. The three kinds
 * map to the three ways the target capability map distinguishes parameters:
 *   - "fixed":   same value every run (baked into the automation).
 *   - "rule":    derived from observable context (time-of-day, trigger
 *                file name, current day-of-week, etc.). Needs a small
 *                LLM-generated decision function.
 *   - "runtime": the user provides it each run (the NL-to-params
 *                extractor routes free-text input here).
 */
export type ParameterKind = "fixed" | "rule" | "runtime";

/**
 * One variable that a flow references abstractly (e.g. `[subject]`,
 * `[folder]`). Populated by the parameters extractor and, over time,
 * refined by interviews and by successive observations.
 */
export interface FlowParameter {
  /** Canonical short name used inside the flow body (e.g. "subject"). */
  name: string;
  /** One-sentence description of what this parameter represents. */
  description: string;
  /** Current classification. `null` when not yet classified — the UI
   *  surfaces these as "needs classification". */
  kind: ParameterKind | null;
  /** Concrete values observed across runs, newest-first. Used as examples
   *  when asking the user to classify / supply a runtime value. */
  observed_values?: string[];
  /** If kind === "fixed", the value used every run. */
  fixed_value?: string;
  /** If kind === "rule", a one-sentence description of how to derive it. */
  rule?: string;
}

export interface FlowFrontmatter {
  type: "complete-flow" | "partial-flow";
  id: string;
  name: string;
  detected: string;
  last_seen: string;
  occurrences: number;
  confidence: "high" | "medium" | "low";
  avg_duration?: number;
  trigger?: string;
  gaps?: number;
  apps: string[];
  /** ISO windowStart timestamps of descriptions that contributed to this flow. */
  source_windows?: string[];
  /** Worthiness tier set by WorthJudge. Optional — older flows predate classification. */
  worth?: FlowWorth;
  /** One-sentence rationale for the worth tier, useful in the UI and for debugging prompts. */
  worth_reason?: string;
  /**
   * Rough estimate of minutes saved per future occurrence IF automated.
   * Derived from `avg_duration` and `occurrences` — see WorthJudge for formula.
   * Intended as a relative ranking signal, not an absolute promise.
   */
  time_saved_estimate_minutes?: number;
  /**
   * Dynamic variables the flow depends on. Populated by the parameters
   * extractor when a flow is first saved or merged with a materially
   * different observation. Absent on older flows.
   */
  parameters?: FlowParameter[];
}

export interface KnowledgeFrontmatter {
  type: "knowledge";
  id: string;
  detected: string;
  category: "decision-pattern" | "habit" | "preference" | "tool-usage";
  apps: string[];
}

export interface FlowDocument {
  frontmatter: FlowFrontmatter;
  body: string;
  filePath: string;
}

export interface KnowledgeDocument {
  frontmatter: KnowledgeFrontmatter;
  body: string;
  filePath: string;
}

export interface DetectionResult {
  newComplete: number;
  updatedComplete: number;
  newPartial: number;
  newKnowledge: number;
  filesWritten: string[];
}

/**
 * Decision from the evaluator pass for a single newly-detected flow.
 * index — position of the flow in the corresponding `complete_flows` array.
 * kind — either save as a new file ("new") or merge into an existing flow ("merge").
 * matchedFlowId — id of the existing flow to merge into, required when kind === "merge".
 * reason — 1-sentence justification, kept for logging and future debugging.
 */
export interface EvaluatorDecision {
  index: number;
  kind: "new" | "merge";
  matchedFlowId?: string;
  reason: string;
}

/**
 * Full evaluator output. `complete` decisions are parallel to the
 * `complete_flows` array from the detection phase. Partials are not
 * merged in the MVP, so there's no `partial` field here.
 *
 * `withinRunDupes` lists newly-detected flows that describe the same
 * activity emitted twice in the same run — the caller collapses them
 * to one "new" flow before saving.
 */
export interface EvaluatorResult {
  complete: EvaluatorDecision[];
  withinRunDupes: { indexA: number; indexB: number; reason: string }[];
}

export interface InterviewQuestion {
  index: number;
  question: string;
  answered: boolean;
  answer?: string;
}

export interface AutomationFile {
  filePath: string;
  filename: string;
  format: string;    // "python" | "nodejs" | "claude-skill" | "tutorial"
  ext: string;       // "py" | "js" | "md"
  createdAt: string; // ISO
  sizeBytes: number;
}

export interface DashboardData {
  completeFlows: FlowDocument[];
  partialFlows: FlowDocument[];
  knowledge: KnowledgeDocument[];
}

// Capture event types
export interface CaptureEvent {
  ts: string;
  type: "click" | "keypress" | "window-change" | "screenshot" | "scroll" | "session-start" | "session-end";
  data: Record<string, unknown>;
}

export interface CaptureStats {
  capturing: boolean;
  sessionId: string | null;
  sessionStartedAt: string | null;
  sessionDuration: number;
  eventCount: number;
  screenshotCount: number;
  audioEnabled: boolean;
}

export interface SessionMeta {
  id: string;
  date: string;
  startedAt: string;
  endedAt?: string;
  eventCount: number;
  screenshotCount: number;
  analyzed: boolean;
}
