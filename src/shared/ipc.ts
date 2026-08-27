import type { DismissedFinding, Finding, ReviewResult, ReviewTarget, SpecialistReport } from '../engine/types.js';
import type { AgentConfig } from '../engine/agents.js';
import type { ThemeSettings } from './themes.js';

export interface ChangedFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  oldPath?: string;
  /** Auto-generated output (lockfile, build artifact, codegen) — see shared/generated.ts. */
  generated?: boolean;
  /** Lines added/removed (`git diff --numstat`); absent for binary files. */
  additions?: number;
  deletions?: number;
}

/** A commit on the branch under review (not in its base). */
/**
 * Where a review target's refs stand right now. The renderer keeps the last one
 * it saw per session and compares on window focus: same shas means the repo
 * hasn't moved and the view can be left alone.
 */
export interface RefState {
  /** Commit the reviewed branch points at. */
  headSha: string;
  /** Commit it is compared against — the merge-base, possibly advanced (see baseVia). */
  baseSha: string;
  /**
   * Set when the branch now sits on a ref other than the session's base ref — it
   * was rebased past it — so the comparison uses that ref instead. `behind` is
   * how many commits the base ref is missing; `landed` says the base ref has been
   * merged into this ref, rather than being the same branch further on.
   */
  baseVia?: { ref: string; behind: number; landed: boolean };
  /**
   * Set when the branch is already wholly in this ref — merged and pushed.
   * Nothing is ahead of it, so the comparison stays on the base ref.
   */
  mergedInto?: string;
}

export interface CommitInfo {
  /** Abbreviated sha. */
  sha: string;
  subject: string;
  author: string;
  /** ISO 8601, author date. */
  date: string;
}

export interface FileDiff {
  path: string;
  oldContent: string;
  newContent: string;
  /** Raw per-file git diff text (fed to the diff viewer as a hunk). */
  hunks: string[];
  lang: string;
}

export interface RepoInfo {
  path: string;
  name: string;
  branches: string[];
  currentBranch: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

export interface ChatReply {
  sessionId: string;
  text: string;
  costUsd: number | null;
}

/** A user-initiated thread anchored to lines in the diff (GitHub-style review comment). */
export interface Comment {
  id: string;
  file: string;
  side: 'old' | 'new';
  startLine: number;
  endLine: number;
  messages: ChatMessage[];
  /**
   * The source text these lines held when the thread was started, used to
   * re-anchor the thread after the file moves under it. Absent on threads
   * created before this was recorded — those keep their stored line numbers.
   */
  quoted?: string;
  /** Collapsed to just the header row in the diff. */
  collapsed?: boolean;
  /** Conversation marked as resolved (GitHub-style). Resolving also collapses the thread. */
  resolved?: boolean;
  /** Specialist agent handling this thread (AppSettings.agents name); unset = the main reviewer. */
  agent?: string;
  /**
   * Answered by your own agent over the file bridge instead of by Margin — set
   * when the thread is started that way or handed over later. Margin makes no AI
   * call for these threads.
   */
  external?: boolean;
  /**
   * Turn currently sitting in the bridge inbox, awaiting a reply. Explicit
   * rather than derived from the last message's role: a thread can be handed
   * over right after Margin answered it, so "last word is the reviewer's" isn't
   * the same thing as "a request is out".
   */
  pendingTurn?: number;
}

export interface Session {
  key: string;
  createdAt?: number;
  repoPath: string;
  repoName: string;
  baseRef: string;
  headRef: string | null;
  status: 'idle' | 'reviewing' | 'done' | 'error';
  transcript: string[];
  findings: Finding[];
  changeSummary: string;
  costUsd: number | null;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } | null;
  error?: string;
  sdkSessionId?: string;
  workDir?: string;
  /** General chat about the changeset. */
  chat?: ChatMessage[];
  /** Per-finding reply threads, keyed by finding index. */
  threads?: Record<number, ChatMessage[]>;
  /** User-initiated line-anchored comment threads. */
  comments?: Comment[];
  /** Collapsed findings, keyed by file::category::summary. */
  collapsedFindings?: Record<string, boolean>;
  /**
   * Findings handed to your own agent and still awaiting a reply, keyed by the
   * finding's `f-…` id (see shared/findingItem.ts) with the outstanding turn as
   * the value. The comment equivalent lives on the comment itself; findings have
   * no such object, so it hangs off the session like collapsedFindings does.
   */
  pendingFindings?: Record<string, number>;
  /** What each specialist finder checked on the last review — see engine/specialists.ts. */
  specialistReports?: SpecialistReport[];
  /** Model override for review + chat in this session ('sonnet' | 'opus' | 'haiku'); unset = Claude Code default. */
  modelChoice?: string;
  /** Commit reviewed last time — enables delta re-reviews. */
  lastReviewedSha?: string;
}

/** Just enough of a session to locate its bridge directory and describe the changeset. */
export type BridgeSession = Pick<Session, 'key' | 'repoPath' | 'baseRef' | 'headRef'>;

/**
 * One comment turn to broker, as flat data.
 *
 * Deliberately not a `Comment`: IPC arguments are structured-cloned, and a live
 * object out of renderer state can turn unclonable once it has crossed the
 * boundary — the failure surfaces as "An object could not be cloned" on the
 * *second* submit of the same thread. Callers rebuild this from primitives.
 */
export interface BridgeTurn {
  /** Thread this belongs to: a comment's uuid, or a finding's `f-…` id. */
  threadId: string;
  /** Which turn of the thread this is — its message count when brokered. */
  turn: number;
  file: string;
  side: 'old' | 'new';
  startLine: number;
  endLine: number;
  quoted?: string;
  messages: ChatMessage[];
  /** Set when the thread is a review finding, so the agent gets the diagnosis too. */
  finding?: { severity: string; category: string; summary: string; failure?: string };
}

export interface PersistedState {
  repos: RepoInfo[];
  sessions: Session[];
}

/** Global app settings (userData/settings.json). */
export interface AppSettings {
  /** Second finder: any OpenAI-compatible endpoint (OpenAI, Ollama, OpenRouter). */
  openai: {
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    /** One model name, or several comma-separated — each runs as its own finder. */
    model: string;
  };
  /** Third finder: CodeRabbit CLI. Sends the diff to CodeRabbit's cloud. */
  coderabbit: {
    enabled: boolean;
  };
  /** Agentic verification pass: cross-examines every finding against the codebase. */
  verifier: {
    enabled: boolean;
    /** Model for the verifier session; '' = the session's model choice. */
    model: string;
  };
  /** Specialist subagents assignable to comment threads, and optionally run as review finders. */
  agents: AgentConfig[];
  /**
   * Who new comment threads go to before you change the picker: 'reviewer'
   * (Margin's own), 'my-agent' (handed over the file bridge), or a specialist's
   * name. Spelled out rather than encoded, since settings.json is hand-edited.
   * A name that no longer matches a configured agent falls back to the reviewer.
   */
  defaultAnswerer: string;
  /** Active theme name + user-made themes (presets live in shared/themes.ts). */
  themes: ThemeSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  openai: { enabled: false, baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '' },
  coderabbit: { enabled: false },
  verifier: { enabled: true, model: '' },
  agents: [
    {
      name: 'security',
      description: 'Security review specialist — attack surfaces, injection, authz, secrets.',
      instructions:
        'You are a security review specialist. Analyze the code you are asked about strictly through a security lens: injection, authn/authz gaps, secrets handling, unsafe deserialization, path traversal, SSRF. Ground every claim in the actual code (read it) and name concrete attack scenarios.',
      rubric: [
        'authz/permission check removed or bypassed',
        'secrets or tokens committed, logged, or exposed to the client',
        'injection (SQL/command/template/HTML) via unsanitized input',
        'external input not validated at a trust boundary',
        'TLS/signature/verification weakened or disabled',
      ].join('\n'),
    },
    {
      name: 'performance',
      description: 'Performance specialist — complexity, allocations, N+1, hot paths.',
      instructions:
        'You are a performance specialist. Analyze the code you are asked about for algorithmic complexity, redundant work, N+1 patterns, unnecessary allocations, and blocking I/O on hot paths. Ground every claim in the actual code and quantify impact where possible.',
      rubric: [
        'N+1 queries or missing pagination',
        'unbounded loops, queries, or allocations',
        'blocking I/O or heavy work on a hot path',
        'missing timeout/retry-with-backoff on network calls',
      ].join('\n'),
    },
  ],
  defaultAnswerer: 'reviewer',
  themes: { active: 'Tokyo Night', custom: [] },
};

/** API exposed to the renderer via the preload bridge. */
export interface MarginApi {
  pickRepo(): Promise<RepoInfo | null>;
  openRepo(path: string): Promise<RepoInfo | null>;
  changedFiles(target: ReviewTarget): Promise<ChangedFile[]>;
  /** Commits on the branch under review; empty for working-tree targets. */
  branchCommits(target: ReviewTarget): Promise<CommitInfo[]>;
  /** Cheap ref snapshot for spotting git activity outside the app; null for working-tree targets. */
  refState(target: ReviewTarget): Promise<RefState | null>;
  fileDiff(target: ReviewTarget, path: string): Promise<FileDiff>;
  runReview(
    sessionKey: string,
    target: ReviewTarget,
    opts?: { model?: string; sinceSha?: string },
  ): Promise<ReviewRunResult>;
  onReviewProgress(cb: (sessionKey: string, line: string) => void): () => void;
  /** Streaming text deltas for the in-flight chat/comment reply of a session. */
  onChatDelta(cb: (sessionKey: string, delta: string) => void): () => void;
  listDismissals(repoPath: string): Promise<DismissedFinding[]>;
  addDismissal(repoPath: string, d: DismissedFinding): Promise<DismissedFinding[]>;
  removeDismissal(repoPath: string, key: string): Promise<DismissedFinding[]>;
  /** Remove a session's temp worktree when the session is deleted. */
  cleanupWorktree(repoPath: string, workDir: string): Promise<void>;
  /**
   * Send a chat turn. Resumes sdkSessionId, or starts a fresh session in workDir when null.
   * Pass repoPath so fresh sessions pick up the app-stored per-repo instructions.
   * Pass agent to delegate the turn to that configured specialist subagent.
   */
  sendChat(
    sessionKey: string,
    sdkSessionId: string | null,
    workDir: string,
    message: string,
    opts?: { model?: string; repoPath?: string; agent?: string },
  ): Promise<ChatReply>;
  /** Directory holding a session's external-agent exchange — shown in the UI so it's copy-pasteable. */
  bridgeDir(session: BridgeSession): Promise<string>;
  /**
   * Broker one comment turn to the user's own agent: writes the inbox file and
   * returns its path. The turn identifies the request within its thread, so a
   * follow-up brokers a new item rather than overwriting the first one.
   */
  bridgeSubmit(session: BridgeSession, turn: BridgeTurn): Promise<string>;
  /** Stop waiting on a brokered turn — takes it off the agent's work list. */
  bridgeWithdraw(session: BridgeSession, threadId: string, turn: number): Promise<void>;
  /** Sessions whose outboxes main should poll for replies (the external-mode ones). */
  bridgeWatch(sessions: BridgeSession[]): Promise<void>;
  /** A reply written by an external agent, to be appended to its thread (comment or finding). */
  onBridgeReply(cb: (sessionKey: string, threadId: string, text: string) => void): () => void;
  /** User's app-stored review instructions for a repo (merged with the repo's committed .margin/margin.md). */
  getRepoInstructions(repoPath: string): Promise<string>;
  saveRepoInstructions(repoPath: string, text: string): Promise<void>;
  /**
   * Validate a session's workDir before a chat turn, creating or recreating the
   * temp worktree when missing (macOS reaps temp dirs). `recreated` means the
   * old dir vanished — the SDK session keyed to it can no longer resume.
   */
  /**
   * Validate a session's worktree before chat runs in it. `recreated` means the
   * old SDK session can no longer resume; `resynced` means the worktree was
   * moved onto the branch's current commit (it had drifted — a rebase or a new
   * commit since the review), so its files match the diff again.
   */
  ensureWorkdir(
    target: ReviewTarget,
    workDir: string | null,
  ): Promise<{ workDir: string; recreated: boolean; resynced?: boolean }>;
  /**
   * Apply a unified diff to the repo's working copy. Runs `git apply --check` first,
   * retrying with lenient matching; `note` says when a lenient level was needed.
   */
  applyPatch(repoPath: string, patch: string): Promise<{ ok: boolean; error?: string; note?: string }>;
  /**
   * Save an exported review to disk via the OS save dialog. Returns the chosen
   * path, or null when the user cancels.
   */
  exportMarkdown(defaultName: string, content: string): Promise<string | null>;
  getSettings(): Promise<AppSettings>;
  /** Open settings.json in the OS default editor (written first so every key is present). */
  openSettingsFile(): Promise<void>;
  saveSettings(settings: AppSettings): Promise<void>;
  loadState(): Promise<PersistedState>;
  saveRepo(repo: RepoInfo): Promise<void>;
  saveSessions(sessions: Session[]): Promise<void>;
  deleteSession(session: Session): Promise<void>;
  removeRepoData(repoPath: string): Promise<void>;
  smokeConfig(): { repo: string; base: string; head: string; run: boolean; chat: string; comment: string; commentFile: string; commentLine: number; model: string; external: boolean; finding: boolean } | null;
}

/** What review:run actually returns: the engine result plus what main added around it. */
export type ReviewRunResult = ReviewResult & { specialistReports?: SpecialistReport[] };

export type { AgentConfig, DismissedFinding, Finding, ReviewResult, ReviewTarget, SpecialistReport };
