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

/** One rubric item's outcome — the "negative assurance" a specialist gives even when it finds nothing. */
export interface RubricCheckResult {
  check: string;
  /** 'finding' means at least one reported finding came from this check. */
  status: 'pass' | 'finding' | 'unclear';
  /** One line of evidence grounded in the code, not a restatement of the check. */
  note: string;
}

/** What a specialist finder did on a review: whether it ran, why, and what it checked. */
export interface SpecialistReport {
  /** Specialist name from settings (e.g. 'security'). */
  agent: string;
  /** False when the specialist judged the changeset outside its specialty. */
  ran: boolean;
  /** Why it ran, or why it was skipped — shown either way. */
  reason: string;
  checks: RubricCheckResult[];
  costUsd: number | null;
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
  /**
   * Fires when the user cancels the review. Every finder stops what it is
   * doing and rejects with a ReviewCancelledError; main-process only, never
   * crosses IPC.
   */
  signal?: AbortSignal;
}

/** What every finder rejects with once its review's signal has fired. */
export class ReviewCancelledError extends Error {
  constructor() {
    super('Review cancelled');
    this.name = 'ReviewCancelledError';
  }
}

/** Fail fast at a step boundary when the review has already been cancelled. */
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ReviewCancelledError();
}

/**
 * An AbortController for one SDK query, tied to the review's signal. The SDK
 * wants a controller it owns per query, so the review-wide signal is relayed
 * rather than shared.
 */
export function queryAbort(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', () => controller.abort(), { once: true });
  return controller;
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
  /**
   * Whether this really was a delta review. False when a delta was asked for but
   * the branch had been rebased, taking the previously reviewed commit off it —
   * the whole changeset was reviewed instead, so these findings replace the old
   * set rather than adding to it.
   */
  incremental: boolean;
  usage: TokenUsage | null;
  costUsd: number | null;
  durationMs: number;
  /** Worktree path the session ran in; kept alive for chat until the session is closed. */
  workDir: string;
}
