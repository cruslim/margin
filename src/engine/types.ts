export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type FindingCategory =
  | 'correctness'
  | 'security'
  | 'performance'
  | 'error-handling'
  | 'test-coverage'
  | 'other';

export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  category: FindingCategory;
  summary: string;
  /** Concrete inputs/state that trigger the defect and what goes wrong. */
  failureScenario: string;
  /** Exact code snippet the finding anchors to, for re-anchoring in the diff viewer. */
  snippet: string;
}

export interface ReviewTarget {
  repoPath: string;
  /** Ref the changes are compared against, e.g. "main". */
  baseRef: string;
  /** Branch/ref under review, or null to review uncommitted working-tree changes. */
  headRef: string | null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ReviewResult {
  sessionId: string;
  target: ReviewTarget;
  findings: Finding[];
  /** Agent's one-paragraph summary of what the change does. */
  changeSummary: string;
  /** Model that actually ran the review (the user's Claude Code default unless overridden). */
  model: string;
  usage: TokenUsage | null;
  costUsd: number | null;
  durationMs: number;
  /** Worktree path the session ran in; kept alive for chat until the session is closed. */
  workDir: string;
}
