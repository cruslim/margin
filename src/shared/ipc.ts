import type { DismissedFinding, Finding, ReviewResult, ReviewTarget } from '../engine/types.js';

export interface ChangedFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  oldPath?: string;
  /** Auto-generated output (lockfile, build artifact, codegen) — see shared/generated.ts. */
  generated?: boolean;
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
  /** Model override for review + chat in this session ('sonnet' | 'opus' | 'haiku'); unset = Claude Code default. */
  modelChoice?: string;
  /** Commit reviewed last time — enables delta re-reviews. */
  lastReviewedSha?: string;
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
  /** Specialist subagents assignable to comment threads. */
  agents: Array<{ name: string; description: string; instructions: string; model?: string }>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  openai: { enabled: false, baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '' },
  coderabbit: { enabled: false },
  verifier: { enabled: false, model: '' },
  agents: [
    {
      name: 'security',
      description: 'Security review specialist — attack surfaces, injection, authz, secrets.',
      instructions:
        'You are a security review specialist. Analyze the code you are asked about strictly through a security lens: injection, authn/authz gaps, secrets handling, unsafe deserialization, path traversal, SSRF. Ground every claim in the actual code (read it) and name concrete attack scenarios.',
    },
    {
      name: 'performance',
      description: 'Performance specialist — complexity, allocations, N+1, hot paths.',
      instructions:
        'You are a performance specialist. Analyze the code you are asked about for algorithmic complexity, redundant work, N+1 patterns, unnecessary allocations, and blocking I/O on hot paths. Ground every claim in the actual code and quantify impact where possible.',
    },
  ],
};

/** API exposed to the renderer via the preload bridge. */
export interface MarginApi {
  pickRepo(): Promise<RepoInfo | null>;
  openRepo(path: string): Promise<RepoInfo | null>;
  changedFiles(target: ReviewTarget): Promise<ChangedFile[]>;
  fileDiff(target: ReviewTarget, path: string): Promise<FileDiff>;
  runReview(
    sessionKey: string,
    target: ReviewTarget,
    opts?: { model?: string; sinceSha?: string },
  ): Promise<ReviewResult>;
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
  /** User's app-stored review instructions for a repo (merged with the repo's committed .margin/margin.md). */
  getRepoInstructions(repoPath: string): Promise<string>;
  saveRepoInstructions(repoPath: string, text: string): Promise<void>;
  /**
   * Validate a session's workDir before a chat turn, creating or recreating the
   * temp worktree when missing (macOS reaps temp dirs). `recreated` means the
   * old dir vanished — the SDK session keyed to it can no longer resume.
   */
  ensureWorkdir(target: ReviewTarget, workDir: string | null): Promise<{ workDir: string; recreated: boolean }>;
  /**
   * Apply a unified diff to the repo's working copy. Runs `git apply --check` first,
   * retrying with lenient matching; `note` says when a lenient level was needed.
   */
  applyPatch(repoPath: string, patch: string): Promise<{ ok: boolean; error?: string; note?: string }>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;
  loadState(): Promise<PersistedState>;
  saveRepo(repo: RepoInfo): Promise<void>;
  saveSessions(sessions: Session[]): Promise<void>;
  deleteSession(session: Session): Promise<void>;
  removeRepoData(repoPath: string): Promise<void>;
  smokeConfig(): { repo: string; base: string; head: string; run: boolean; chat: string; comment: string; commentFile: string; commentLine: number; model: string } | null;
}

export type { DismissedFinding, Finding, ReviewResult, ReviewTarget };
