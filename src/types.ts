// Flow document types matching the spec's output formats

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
