import type { Finding, ReviewResult, ReviewTarget } from '../engine/types.js';

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
}

export interface PersistedState {
  repos: RepoInfo[];
  sessions: Session[];
}

/** API exposed to the renderer via the preload bridge. */
export interface MarginApi {
  pickRepo(): Promise<RepoInfo | null>;
  openRepo(path: string): Promise<RepoInfo | null>;
  changedFiles(target: ReviewTarget): Promise<ChangedFile[]>;
  fileDiff(target: ReviewTarget, path: string): Promise<FileDiff>;
  runReview(sessionKey: string, target: ReviewTarget): Promise<ReviewResult>;
  onReviewProgress(cb: (sessionKey: string, line: string) => void): () => void;
  /** Remove a session's temp worktree when the session is deleted. */
  cleanupWorktree(repoPath: string, workDir: string): Promise<void>;
  /** Send a follow-up turn into a review session (chat). Progress streams via onReviewProgress. */
  sendChat(sessionKey: string, sdkSessionId: string, workDir: string, message: string): Promise<ChatReply>;
  /** Apply a unified diff to the repo's working copy. Runs `git apply --check` first. */
  applyPatch(repoPath: string, patch: string): Promise<{ ok: boolean; error?: string }>;
  loadState(): Promise<PersistedState>;
  saveRepo(repo: RepoInfo): Promise<void>;
  saveSessions(sessions: Session[]): Promise<void>;
  deleteSession(session: Session): Promise<void>;
  removeRepoData(repoPath: string): Promise<void>;
  smokeConfig(): { repo: string; base: string; head: string; run: boolean; chat: string } | null;
}

export type { Finding, ReviewResult, ReviewTarget };
