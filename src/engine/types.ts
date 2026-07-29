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
  /** Which reviewer produced this finding (e.g. 'gpt-5', 'coderabbit'); unset = Claude agentic reviewer. */
  source?: string;
  /** Verifier's adjudication, when the verifier pass ran. */
  verdict?: 'confirmed' | 'refuted' | 'uncertain';
  verdictReason?: string;
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

/** A finding the user dismissed — remembered per repo so re-reviews don't resurface it. */
export interface DismissedFinding {
  file: string;
  category: string;
  summary: string;
  snippet?: string;
  at: number;
}

export interface ReviewOptions {
  /** Model override (e.g. 'sonnet', 'opus', 'haiku'); omit for the Claude Code default. */
  model?: string;
  /** Review only changes since this commit (delta re-review). */
  sinceSha?: string;
  /** Previously dismissed findings — the reviewer is told not to report them again. */
  dismissed?: DismissedFinding[];
  /** User's per-repo instructions stored in the app, merged with the repo's .margin/margin.md. */
  instructions?: string;
}

export interface ReviewResult {
  sessionId: string;
  target: ReviewTarget;
  findings: Finding[];
  /** Agent's one-paragraph summary of what the change does. */
  changeSummary: string;
  /** Model that actually ran the review (the user's Claude Code default unless overridden). */
  model: string;
  /** Commit the reviewed ref pointed at, for delta re-reviews. Null for working-tree reviews. */
  headSha: string | null;
  usage: TokenUsage | null;
  costUsd: number | null;
  durationMs: number;
  /** Worktree path the session ran in; kept alive for chat until the session is closed. */
  workDir: string;
}
