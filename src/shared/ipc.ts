import type { DismissedFinding, Finding, ReviewResult, ReviewTarget } from '../engine/types.js';

export interface ChangedFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  oldPath?: string;
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
  /** Collapsed to just the header row in the diff. */
  collapsed?: boolean;
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
}

export const DEFAULT_SETTINGS: AppSettings = {
  openai: { enabled: false, baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '' },
  coderabbit: { enabled: false },
  verifier: { enabled: false, model: '' },
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
  /** Send a chat turn. Resumes sdkSessionId, or starts a fresh session in workDir when null. */
  sendChat(
    sessionKey: string,
    sdkSessionId: string | null,
    workDir: string,
    message: string,
    opts?: { model?: string },
  ): Promise<ChatReply>;
  /** Ensure a workdir exists for a session (temp worktree for branch reviews) before any review ran. */
  prepareWorkdir(target: ReviewTarget): Promise<string>;
  /** Apply a unified diff to the repo's working copy. Runs `git apply --check` first. */
  applyPatch(repoPath: string, patch: string): Promise<{ ok: boolean; error?: string }>;
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
