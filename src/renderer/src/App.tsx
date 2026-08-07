import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BridgeSession,
  ChangedFile,
  ChatMessage,
  Comment,
  CommitInfo,
  DismissedFinding,
  FileDiff,
  Finding,
  RepoInfo,
  ReviewTarget,
  Session,
} from '../../shared/ipc.js';
import { reanchor } from './components/reanchor.js';
import { answererFromSetting } from './components/answerer.js';
import { findingItemId, isFindingItem } from '../../shared/findingItem.js';

/** Which thread the in-flight chat turn belongs to, for routing streamed text. */
export type ChatScope = { type: 'chat' } | { type: 'finding'; index: number } | { type: 'comment'; id: string };

export function dismissalKey(d: Pick<DismissedFinding, 'file' | 'category' | 'summary'>): string {
  return `${d.file}::${d.category}::${d.summary}`;
}
import { applyTheme } from './theme.js';
import { resolveTheme } from '../../shared/themes.js';
import { Sidebar } from './components/Sidebar.js';
import { SettingsModal } from './components/SettingsModal.js';
import { InstructionsModal } from './components/InstructionsModal.js';
import { DiffPane } from './components/DiffPane.js';
import { FindingThread, ReviewPanel } from './components/ReviewPanel.js';
import { FileList, conversationStates } from './components/FileList.js';
import { ResizeHandle, usePanelCollapsed, usePanelWidth } from './components/Resizer.js';

export type { Session };

export function targetOf(s: Session): ReviewTarget {
  return { repoPath: s.repoPath, baseRef: s.baseRef, headRef: s.headRef };
}

/** Sessions carry transcripts and findings; the bridge only needs the identity bits. */
function bridgeSessionOf(s: Session): BridgeSession {
  return { key: s.key, repoPath: s.repoPath, baseRef: s.baseRef, headRef: s.headRef };
}

/**
 * Does this session have any request sitting in the bridge inbox? Both kinds
 * count — a handed-off finding needs its reply polled for exactly as a comment
 * does, and missing it here would leave the reply sitting in `outbox/` forever.
 */
function hasPendingBridgeWork(s: Session): boolean {
  return (
    (s.comments ?? []).some((c) => c.pendingTurn != null) ||
    Object.keys(s.pendingFindings ?? {}).length > 0
  );
}

export function sessionTitle(s: Session): string {
  return s.headRef ?? 'uncommitted changes';
}

/** File to open by default: something hand-written — a lockfile is rarely what you came to read. */
function firstReadable(files: ChangedFile[]): string | null {
  return (files.find((f) => !f.generated) ?? files[0])?.path ?? null;
}

export function App() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [files, setFiles] = useState<ChangedFile[]>([]);
  /** Bumped to force the open file's diff to refetch on an explicit refresh. */
  const [diffReloadKey, setDiffReloadKey] = useState(0);
  // The open file's diff lives here rather than in DiffPane: its content is what
  // re-anchors findings and comments, and the findings panel needs the same
  // anchors the diff uses or the two disagree about where a finding is.
  const [openDiff, setOpenDiff] = useState<FileDiff | null>(null);
  const [openDiffError, setOpenDiffError] = useState<string | null>(null);
  /** Commits on the active branch, listed under its row in the sidebar. */
  const [branchCommits, setBranchCommits] = useState<CommitInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  /** Bumped by the file list's conversation icon; DiffPane scrolls to the thread. */
  const [revealConvo, setRevealConvo] = useState(0);
  const [chatBusy, setChatBusy] = useState<Record<string, boolean>>({});
  const [streamText, setStreamText] = useState<Record<string, string>>({});
  const [chatScope, setChatScope] = useState<Record<string, ChatScope>>({});
  const [dismissals, setDismissals] = useState<Record<string, DismissedFinding[]>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [instructionsRepo, setInstructionsRepo] = useState<RepoInfo | null>(null);
  const [agentNames, setAgentNames] = useState<string[]>([]);
  /** Picker value new comment threads start on (AppSettings.defaultAnswerer). */
  const [defaultAnswerer, setDefaultAnswerer] = useState('');
  const [themeMode, setThemeMode] = useState<'dark' | 'light'>('dark');

  // Settings-derived state (agent names, theme); refresh after settings close —
  // reapplying the saved theme also reverts any live preview from the editor.
  useEffect(() => {
    if (settingsOpen) return;
    // Cancelled on reopen so a slow read can't clobber the editor's live preview.
    let cancelled = false;
    window.margin
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        const names = s.agents.filter((a) => a.name.trim() && a.instructions.trim()).map((a) => a.name.trim());
        setAgentNames(names);
        // Resolved against the live agent list, so a deleted specialist can't
        // stay the default.
        setDefaultAnswerer(answererFromSetting(s.defaultAnswerer, names));
        const theme = resolveTheme(s.themes);
        applyTheme(theme);
        setThemeMode(theme.mode);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [settingsOpen]);
  const loaded = useRef(false);
  // True until persisted state has arrived — renders the boot mark instead of
  // flashing the empty "Add repository" hero at users who have repos.
  const [booting, setBooting] = useState(true);

  const sidebarPanel = usePanelWidth('sidebar', 230, 160, 480, 1);
  const filesPanel = usePanelWidth('filelist', 220, 150, 520, 1);
  const reviewPanel = usePanelWidth('review', 340, 260, 720, -1);
  const reviewCollapsed = usePanelCollapsed('review');
  const sidebarCollapsed = usePanelCollapsed('sidebar');

  const active = useMemo(() => sessions.find((s) => s.key === activeKey) ?? null, [sessions, activeKey]);

  const sidebarHidden = sidebarCollapsed.collapsed && active !== null;

  // Load persisted JSON state once on startup (skipped in smoke mode, which seeds its own).
  useEffect(() => {
    if (window.margin.smokeConfig()) {
      loaded.current = true;
      setBooting(false);
      return;
    }
    window.margin.loadState().then((state) => {
      setRepos(state.repos);
      setSessions(state.sessions);
      loaded.current = true;
      setBooting(false);
      // loadState serves the stored snapshot without touching git — refresh
      // every repo's branch list in the background, in parallel.
      for (const r of state.repos) {
        window.margin.openRepo(r.path).then((repo) => {
          if (!repo) return;
          window.margin.saveRepo(repo).catch(() => {});
          setRepos((prev) => prev.map((x) => (x.path === repo.path ? repo : x)));
        });
      }
    });
  }, []);

  // Debounced write-through of sessions to their JSON files.
  useEffect(() => {
    if (!loaded.current || sessions.length === 0) return;
    const t = setTimeout(() => window.margin.saveSessions(sessions), 400);
    return () => clearTimeout(t);
  }, [sessions]);

  const patchSession = useCallback((key: string, patch: Partial<Session> | ((s: Session) => Partial<Session>)) => {
    setSessions((prev) =>
      prev.map((s) => (s.key === key ? { ...s, ...(typeof patch === 'function' ? patch(s) : patch) } : s)),
    );
  }, []);

  useEffect(() => {
    return window.margin.onReviewProgress((sessionKey, line) => {
      patchSession(sessionKey, (s) => ({ transcript: [...s.transcript, line] }));
    });
  }, [patchSession]);

  useEffect(() => {
    return window.margin.onChatDelta((sessionKey, delta) => {
      setStreamText((prev) => ({ ...prev, [sessionKey]: (prev[sessionKey] ?? '') + delta }));
    });
  }, []);

  // Load repo-level dismissals for the active session's repo.
  useEffect(() => {
    if (!active?.repoPath || dismissals[active.repoPath]) return;
    window.margin.listDismissals(active.repoPath).then((d) => {
      setDismissals((prev) => ({ ...prev, [active.repoPath]: d }));
    });
  }, [active?.repoPath, dismissals]);

  // Load changed files when the active session changes.
  useEffect(() => {
    setFiles([]);
    setSelectedFile(null);
    if (!active) return;
    let cancelled = false;
    window.margin
      .changedFiles(targetOf(active))
      .then((f) => {
        if (cancelled) return;
        setFiles(f);
        setSelectedFile(firstReadable(f));
      })
      .catch(() => setFiles([]));
    return () => {
      cancelled = true;
    };
  }, [activeKey, active?.repoPath, active?.baseRef, active?.headRef]);

  // Commits on the active branch. Keyed on the same things as the file list plus
  // the refresh counter, so ↻ re-reads the commit list along with the changeset.
  useEffect(() => {
    if (!active?.headRef) {
      setBranchCommits([]);
      return;
    }
    let cancelled = false;
    window.margin
      .branchCommits(targetOf(active))
      .then((c) => !cancelled && setBranchCommits(c))
      .catch(() => !cancelled && setBranchCommits([]));
    return () => {
      cancelled = true;
    };
  }, [activeKey, active?.repoPath, active?.baseRef, active?.headRef, diffReloadKey]);

  // Load the open file's diff. Refetches on an explicit refresh even when the
  // path is unchanged, since the content behind it may have moved.
  useEffect(() => {
    if (!active || !selectedFile) {
      setOpenDiff(null);
      setOpenDiffError(null);
      return;
    }
    let cancelled = false;
    setOpenDiff(null);
    setOpenDiffError(null);
    window.margin
      .fileDiff(targetOf(active), selectedFile)
      .then((d) => !cancelled && setOpenDiff(d))
      .catch((e) => !cancelled && setOpenDiffError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [active?.repoPath, active?.baseRef, active?.headRef, selectedFile, diffReloadKey]);

  /**
   * Re-read the changeset. Branch sessions diff `base...branch`, so git resolves
   * the branch tip on every call — new commits show up here. Keeps the selected
   * file when it's still in the set, and bumps the diff key so the open file
   * refetches even though its path didn't change.
   */
  const refreshSession = useCallback(
    async (key: string) => {
      // A different branch: selecting it loads its changeset fresh anyway.
      if (key !== activeKey) {
        setActiveKey(key);
        return;
      }
      if (!active) return;
      const f = await window.margin.changedFiles(targetOf(active)).catch(() => null);
      if (!f) return; // leave the current view alone rather than blanking it
      setFiles(f);
      setSelectedFile((prev) => (prev && f.some((x) => x.path === prev) ? prev : firstReadable(f)));
      setDiffReloadKey((k) => k + 1);
    },
    [active, activeKey],
  );

  const addRepo = useCallback(async () => {
    const repo = await window.margin.pickRepo();
    if (!repo) return;
    window.margin.saveRepo(repo).catch(() => {});
    setRepos((prev) => (prev.some((r) => r.path === repo.path) ? prev : [...prev, repo]));
  }, []);

  const refreshRepo = useCallback(async (path: string) => {
    const repo = await window.margin.openRepo(path);
    if (!repo) return;
    window.margin.saveRepo(repo).catch(() => {});
    setRepos((prev) => prev.map((r) => (r.path === path ? repo : r)));
  }, []);

  const deleteSession = useCallback(
    (key: string) => {
      const session = sessions.find((s) => s.key === key);
      if (session) {
        window.margin.deleteSession(session).catch(() => {});
        if (session.workDir && session.workDir !== session.repoPath) {
          window.margin.cleanupWorktree(session.repoPath, session.workDir).catch(() => {});
        }
      }
      setSessions((prev) => prev.filter((s) => s.key !== key));
      setActiveKey((prev) => (prev === key ? null : prev));
    },
    [sessions],
  );

  const removeRepo = useCallback(
    (path: string) => {
      const repoSessions = sessions.filter((s) => s.repoPath === path);
      if (repoSessions.length > 0 && !window.confirm(`Remove repository and its ${repoSessions.length} review session(s)?`)) {
        return;
      }
      for (const s of repoSessions) {
        if (s.workDir && s.workDir !== s.repoPath) {
          window.margin.cleanupWorktree(s.repoPath, s.workDir).catch(() => {});
        }
      }
      window.margin.removeRepoData(path).catch(() => {});
      setRepos((prev) => prev.filter((r) => r.path !== path));
      setSessions((prev) => prev.filter((s) => s.repoPath !== path));
      setActiveKey((prev) => (repoSessions.some((s) => s.key === prev) ? null : prev));
    },
    [sessions],
  );

  const newSession = useCallback((repo: RepoInfo, baseRef: string, headRef: string | null) => {
    const session: Session = {
      key: crypto.randomUUID(),
      createdAt: Date.now(),
      repoPath: repo.path,
      repoName: repo.name,
      baseRef,
      headRef,
      status: 'idle',
      transcript: [],
      findings: [],
      changeSummary: '',
      costUsd: null,
    };
    setSessions((prev) => [...prev, session]);
    setActiveKey(session.key);
  }, []);

  const runReview = useCallback(
    async (session: Session, mode: 'full' | 'delta' = 'full') => {
      const sinceSha =
        mode === 'delta' && session.lastReviewedSha && session.headRef ? session.lastReviewedSha : undefined;
      patchSession(session.key, (s) => ({
        status: 'reviewing',
        transcript: [],
        findings: sinceSha ? s.findings : [],
        error: undefined,
      }));
      try {
        const result = await window.margin.runReview(session.key, targetOf(session), {
          model: session.modelChoice,
          sinceSha,
        });
        patchSession(session.key, (s) => ({
          status: 'done',
          // Delta reviews append new findings; full reviews replace.
          findings: sinceSha ? [...s.findings, ...result.findings] : result.findings,
          changeSummary: result.changeSummary,
          costUsd: sinceSha ? (s.costUsd ?? 0) + (result.costUsd ?? 0) : result.costUsd,
          model: result.model,
          usage: result.usage,
          sdkSessionId: result.sessionId,
          workDir: result.workDir,
          lastReviewedSha: result.headSha ?? undefined,
        }));
        return result;
      } catch (err) {
        // A delta review with nothing new arrives through the error path, but
        // it's an up-to-date state, not a failure — keep the prior findings.
        if (String(err).includes('No new changes since the last review')) {
          patchSession(session.key, (s) => ({
            status: 'done',
            transcript: [...s.transcript, 'Already up to date — no new commits since the last review.'],
          }));
          return null;
        }
        patchSession(session.key, { status: 'error', error: String(err) });
        return null;
      }
    },
    [patchSession],
  );

  const dismissFinding = useCallback(
    async (session: Session, finding: Finding) => {
      const d: DismissedFinding = {
        file: finding.file,
        category: finding.category,
        summary: finding.summary,
        snippet: finding.snippet,
        at: Date.now(),
      };
      const all = await window.margin.addDismissal(session.repoPath, d);
      setDismissals((prev) => ({ ...prev, [session.repoPath]: all }));
    },
    [],
  );

  const restoreDismissal = useCallback(async (repoPath: string, key: string) => {
    const all = await window.margin.removeDismissal(repoPath, key);
    setDismissals((prev) => ({ ...prev, [repoPath]: all }));
  }, []);

  // Validate the session's workDir (macOS reaps temp worktrees). When it had to
  // be recreated, the old SDK session can't resume — drop it and start fresh.
  const ensureSessionWorkdir = useCallback(
    async (session: Session): Promise<{ workDir: string; sdkSessionId: string | null }> => {
      const res = await window.margin.ensureWorkdir(targetOf(session), session.workDir ?? null);
      if (res.recreated) {
        patchSession(session.key, { workDir: res.workDir, sdkSessionId: undefined });
        return { workDir: res.workDir, sdkSessionId: null };
      }
      return { workDir: res.workDir, sdkSessionId: session.sdkSessionId ?? null };
    },
    [patchSession],
  );

  const appendChatMessage = useCallback(
    (sessionKey: string, msg: ChatMessage, findingIndex?: number) => {
      patchSession(sessionKey, (s) =>
        findingIndex == null
          ? { chat: [...(s.chat ?? []), msg] }
          : { threads: { ...(s.threads ?? {}), [findingIndex]: [...(s.threads?.[findingIndex] ?? []), msg] } },
      );
    },
    [patchSession],
  );

  const sendChatCore = useCallback(
    async (
      sessionKey: string,
      sdkSessionId: string | null,
      workDir: string,
      displayText: string,
      prompt: string,
      findingIndex?: number,
      model?: string,
    ) => {
      appendChatMessage(sessionKey, { role: 'user', text: displayText, at: Date.now() }, findingIndex);
      setChatBusy((b) => ({ ...b, [sessionKey]: true }));
      setChatScope((p) => ({ ...p, [sessionKey]: findingIndex == null ? { type: 'chat' } : { type: 'finding', index: findingIndex } }));
      setStreamText((p) => ({ ...p, [sessionKey]: '' }));
      try {
        const reply = await window.margin.sendChat(sessionKey, sdkSessionId, workDir, prompt, { model });
        appendChatMessage(sessionKey, { role: 'assistant', text: reply.text, at: Date.now() }, findingIndex);
        patchSession(sessionKey, (s) => ({
          sdkSessionId: reply.sessionId,
          costUsd: (s.costUsd ?? 0) + (reply.costUsd ?? 0),
        }));
      } catch (err) {
        appendChatMessage(sessionKey, { role: 'assistant', text: `Error: ${String(err)}`, at: Date.now() }, findingIndex);
      } finally {
        setChatBusy((b) => ({ ...b, [sessionKey]: false }));
        setStreamText((p) => ({ ...p, [sessionKey]: '' }));
        setChatScope((p) => {
          const { [sessionKey]: _, ...rest } = p;
          return rest;
        });
      }
    },
    [appendChatMessage, patchSession],
  );

  const sendChat = useCallback(
    async (session: Session, text: string, findingIndex?: number) => {
      if (!session.sdkSessionId || !session.workDir || chatBusy[session.key]) return;
      let prompt = text;
      if (findingIndex != null) {
        const f = session.findings[findingIndex];
        prompt = `Regarding your review finding "${f.summary}" at ${f.file}:${f.line}:\n\n${text}`;
      }
      const { workDir, sdkSessionId } = await ensureSessionWorkdir(session);
      sendChatCore(session.key, sdkSessionId, workDir, text, prompt, findingIndex, session.modelChoice);
    },
    [sendChatCore, chatBusy, ensureSessionWorkdir],
  );

  const proposeFix = useCallback(
    async (session: Session, findingIndex: number) => {
      if (!session.sdkSessionId || !session.workDir || chatBusy[session.key]) return;
      const f = session.findings[findingIndex];
      const prompt =
        `Propose a minimal fix for your review finding "${f.summary}" at ${f.file}:${f.line}. ` +
        'Reply with a one-paragraph explanation followed by exactly ONE unified diff inside a ```diff code fence, ' +
        'using a/ b/ path prefixes so it applies cleanly with `git apply` from the repo root. No other code blocks.';
      const { workDir, sdkSessionId } = await ensureSessionWorkdir(session);
      sendChatCore(session.key, sdkSessionId, workDir, 'Propose a fix', prompt, findingIndex, session.modelChoice);
    },
    [sendChatCore, chatBusy, ensureSessionWorkdir],
  );

  const applyPatch = useCallback(
    async (session: Session, patch: string, findingIndex?: number) => {
      if (!window.confirm(`Apply this patch to the working copy of ${session.repoName}?`)) return;
      const res = await window.margin.applyPatch(session.repoPath, patch);
      appendChatMessage(
        session.key,
        {
          role: 'assistant',
          text: res.ok
            ? `✔ Patch applied to the working copy.${res.note ? ` (${res.note})` : ''}`
            : `✘ git apply failed:\n${res.error}`,
          at: Date.now(),
        },
        findingIndex,
      );
    },
    [appendChatMessage],
  );

  const appendToComment = useCallback(
    (sessionKey: string, commentId: string, msg: ChatMessage) => {
      patchSession(sessionKey, (s) => ({
        comments: (s.comments ?? []).map((c) => (c.id === commentId ? { ...c, messages: [...c.messages, msg] } : c)),
      }));
    },
    [patchSession],
  );

  const applyPatchToComment = useCallback(
    async (session: Session, patch: string, commentId: string) => {
      if (!window.confirm(`Apply this patch to the working copy of ${session.repoName}?`)) return;
      const res = await window.margin.applyPatch(session.repoPath, patch);
      appendToComment(session.key, commentId, {
        role: 'assistant',
        text: res.ok
          ? `✔ Patch applied to the working copy.${res.note ? ` (${res.note})` : ''}`
          : `✘ git apply failed:\n${res.error}`,
        at: Date.now(),
      });
    },
    [appendToComment],
  );

  const runCommentTurn = useCallback(
    async (session: Session, commentId: string, prompt: string, agent?: string) => {
      setChatBusy((b) => ({ ...b, [session.key]: true }));
      setChatScope((p) => ({ ...p, [session.key]: { type: 'comment', id: commentId } }));
      setStreamText((p) => ({ ...p, [session.key]: '' }));
      try {
        // Comments work before any review ran: lazily prepare a workdir and
        // let chat() start a fresh session when there's nothing to resume.
        const { workDir, sdkSessionId } = await ensureSessionWorkdir(session);
        const reply = await window.margin.sendChat(session.key, sdkSessionId, workDir, prompt, {
          model: session.modelChoice,
          repoPath: session.repoPath,
          agent,
        });
        patchSession(session.key, (s) => ({
          sdkSessionId: reply.sessionId,
          workDir,
          costUsd: (s.costUsd ?? 0) + (reply.costUsd ?? 0),
        }));
        appendToComment(session.key, commentId, { role: 'assistant', text: reply.text, at: Date.now() });
      } catch (err) {
        appendToComment(session.key, commentId, { role: 'assistant', text: `Error: ${String(err)}`, at: Date.now() });
      } finally {
        setChatBusy((b) => ({ ...b, [session.key]: false }));
        setStreamText((p) => ({ ...p, [session.key]: '' }));
        setChatScope((p) => {
          const { [session.key]: _, ...rest } = p;
          return rest;
        });
      }
    },
    [appendToComment, patchSession, ensureSessionWorkdir],
  );

  /** Patch one comment in place. */
  const patchComment = useCallback(
    (sessionKey: string, commentId: string, patch: Partial<Comment>) => {
      patchSession(sessionKey, (s) => ({
        comments: (s.comments ?? []).map((c) => (c.id === commentId ? { ...c, ...patch } : c)),
      }));
    },
    [patchSession],
  );

  /**
   * Hand a turn to the user's own agent: the request leaves as a file and the
   * reply arrives whenever the agent writes one (see the bridge:reply listener
   * below). Nothing is awaited and no AI call is made, so several threads can be
   * out at once and the session stays usable.
   */
  const brokerTurn = useCallback(
    async (session: Session, comment: Comment) => {
      const turn = comment.messages.length;
      patchComment(session.key, comment.id, { external: true, pendingTurn: turn });
      try {
        // Rebuilt field by field rather than passed as-is: IPC structured-clones
        // its arguments, and a comment that has already crossed the boundary once
        // comes back unclonable, so a thread's *second* turn would fail.
        await window.margin.bridgeSubmit(bridgeSessionOf(session), {
          threadId: comment.id,
          turn,
          file: comment.file,
          side: comment.side,
          startLine: comment.startLine,
          endLine: comment.endLine,
          quoted: comment.quoted,
          messages: comment.messages.map((m) => ({ role: m.role, text: m.text, at: m.at })),
        });
      } catch (err) {
        patchComment(session.key, comment.id, { pendingTurn: undefined });
        appendToComment(session.key, comment.id, {
          role: 'assistant',
          text: `Error: could not hand this to your agent — ${String(err)}`,
          at: Date.now(),
        });
      }
    },
    [appendToComment, patchComment],
  );

  // Replies from your agent, appended like any other message — the debounced
  // session save picks them up with no extra work.
  useEffect(() => {
    return window.margin.onBridgeReply((sessionKey, threadId, text) => {
      const msg: ChatMessage = { role: 'assistant', text, at: Date.now() };
      if (!isFindingItem(threadId)) {
        appendToComment(sessionKey, threadId, msg);
        patchComment(sessionKey, threadId, { pendingTurn: undefined });
        return;
      }
      // Findings are keyed by index in `threads`, but the bridge item is named by
      // the finding's stable id — map back through it, so a re-review that
      // reordered findings can't land the reply on the wrong one.
      setSessions((prev) =>
        prev.map((s) => {
          if (s.key !== sessionKey) return s;
          const index = s.findings.findIndex((f) => findingItemId(f) === threadId);
          if (index < 0) return s;
          const { [threadId]: _done, ...restPending } = s.pendingFindings ?? {};
          return {
            ...s,
            threads: { ...(s.threads ?? {}), [index]: [...(s.threads?.[index] ?? []), msg] },
            pendingFindings: restPending,
          };
        }),
      );
    });
  }, [appendToComment, patchComment]);

  /** Hand over a thread as it stands — typically after reading Margin's answer to it. */
  const handOff = useCallback(
    (session: Session, comment: Comment) => brokerTurn(session, comment),
    [brokerTurn],
  );

  /**
   * Hand a review finding to your own agent. Same bridge, same one-item-per-turn
   * rule; the item carries the diagnosis so the agent can act without the
   * reviewer restating it.
   */
  const handOffFinding = useCallback(
    async (session: Session, finding: Finding) => {
      const threadId = findingItemId(finding);
      // Derived, not passed in: the diff pane's findings are filtered to one file,
      // so callers there have no index — and the id is stable enough to look up.
      const index = session.findings.findIndex((f) => findingItemId(f) === threadId);
      const messages = index < 0 ? [] : session.threads?.[index] ?? [];
      const turn = messages.length;
      patchSession(session.key, (s) => ({
        pendingFindings: { ...(s.pendingFindings ?? {}), [threadId]: turn },
      }));
      try {
        await window.margin.bridgeSubmit(bridgeSessionOf(session), {
          threadId,
          turn,
          file: finding.file,
          side: 'new',
          startLine: finding.line,
          endLine: finding.line,
          quoted: finding.snippet,
          messages: messages.map((m) => ({ role: m.role, text: m.text, at: m.at })),
          finding: {
            severity: finding.severity,
            category: finding.category,
            summary: finding.summary,
            failure: finding.failureScenario,
          },
        });
      } catch (err) {
        patchSession(session.key, (s) => {
          const { [threadId]: _failed, ...rest } = s.pendingFindings ?? {};
          return { pendingFindings: rest };
        });
        if (index >= 0) {
          appendChatMessage(
            session.key,
            { role: 'assistant', text: `Error: could not hand this to your agent — ${String(err)}`, at: Date.now() },
            index,
          );
        }
      }
    },
    [appendChatMessage, patchSession],
  );

  /** Give up on a finding that was handed over. */
  const stopWaitingFinding = useCallback(
    async (session: Session, finding: Finding) => {
      const threadId = findingItemId(finding);
      const turn = session.pendingFindings?.[threadId];
      patchSession(session.key, (s) => {
        const { [threadId]: _dropped, ...rest } = s.pendingFindings ?? {};
        return { pendingFindings: rest };
      });
      if (turn != null) {
        await window.margin.bridgeWithdraw(bridgeSessionOf(session), threadId, turn).catch(() => {});
      }
    },
    [patchSession],
  );

  /** Give up on an outstanding turn: off the agent's work list, and no longer pending. */
  const stopWaiting = useCallback(
    async (session: Session, comment: Comment) => {
      const turn = comment.pendingTurn;
      patchComment(session.key, comment.id, { pendingTurn: undefined });
      if (turn != null) {
        await window.margin.bridgeWithdraw(bridgeSessionOf(session), comment.id, turn).catch(() => {});
      }
    },
    [patchComment],
  );

  const addComment = useCallback(
    (
      session: Session,
      file: string,
      side: 'old' | 'new',
      startLine: number,
      endLine: number,
      quoted: string,
      text: string,
      answerer: { agent?: string; external?: boolean } = {},
    ) => {
      // An in-flight Margin turn is no reason to refuse a handoff — that path
      // never touches the model.
      if (chatBusy[session.key] && !answerer.external) return;
      const comment: Comment = {
        id: crypto.randomUUID(),
        file,
        side,
        startLine,
        endLine,
        // Kept so the thread can re-anchor itself once the file shifts.
        quoted: quoted || undefined,
        messages: [{ role: 'user', text, at: Date.now() }],
        agent: answerer.agent,
        external: answerer.external,
      };
      patchSession(session.key, (s) => ({ comments: [...(s.comments ?? []), comment] }));
      if (answerer.external) {
        brokerTurn(session, comment);
        return;
      }
      const lineDesc = startLine === endLine ? `line ${endLine}` : `lines ${startLine}-${endLine}`;
      const prompt =
        `The user commented on ${file}, ${lineDesc} (${side === 'old' ? 'old/removed side of the diff' : 'new version'}).` +
        (quoted ? `\nThe line(s) read:\n\`\`\`\n${quoted}\n\`\`\`` : '') +
        `\nChangeset under review: ${session.baseRef}...${session.headRef ?? 'working tree'}.\n\n${text}`;
      runCommentTurn(session, comment.id, prompt, answerer.agent);
    },
    [chatBusy, patchSession, runCommentTurn, brokerTurn],
  );

  const toggleCollapseFinding = useCallback(
    (session: Session, finding: Finding) => {
      const key = dismissalKey(finding);
      patchSession(session.key, (s) => ({
        collapsedFindings: { ...(s.collapsedFindings ?? {}), [key]: !s.collapsedFindings?.[key] },
      }));
    },
    [patchSession],
  );

  const toggleCollapseComment = useCallback(
    (session: Session, commentId: string) => {
      patchSession(session.key, (s) => ({
        comments: (s.comments ?? []).map((c) => (c.id === commentId ? { ...c, collapsed: !c.collapsed } : c)),
      }));
    },
    [patchSession],
  );

  const toggleResolveComment = useCallback(
    (session: Session, commentId: string) => {
      patchSession(session.key, (s) => ({
        comments: (s.comments ?? []).map((c) =>
          c.id === commentId ? { ...c, resolved: !c.resolved, collapsed: !c.resolved } : c,
        ),
      }));
    },
    [patchSession],
  );

  const deleteComment = useCallback(
    (session: Session, comment: Comment) => {
      if (!window.confirm('Delete this comment thread?')) return;
      patchSession(session.key, (s) => ({
        comments: (s.comments ?? []).filter((c) => c.id !== comment.id),
      }));
      // Don't leave an agent working on a thread that no longer exists.
      if (comment.pendingTurn != null) {
        window.margin.bridgeWithdraw(bridgeSessionOf(session), comment.id, comment.pendingTurn).catch(() => {});
      }
    },
    [patchSession],
  );

  const replyComment = useCallback(
    (session: Session, comment: Comment, text: string) => {
      if (chatBusy[session.key] && !comment.external) return;
      const msg: ChatMessage = { role: 'user', text, at: Date.now() };
      appendToComment(session.key, comment.id, msg);
      // A thread keeps its answerer, exactly as specialist threads do.
      if (comment.external) {
        // Brokered with this message included, so the turn number differs from the
        // opening request's — a follow-up gets its own item instead of overwriting it.
        brokerTurn(session, { ...comment, messages: [...comment.messages, msg] });
        return;
      }
      const prompt = `Continuing the comment thread on ${comment.file}:${comment.endLine} (${comment.side} side):\n\n${text}`;
      // Replies stay with the thread's specialist agent.
      runCommentTurn(session, comment.id, prompt, comment.agent);
    },
    [chatBusy, appendToComment, runCommentTurn, brokerTurn],
  );

  // Smoke-test mode: preload a session for the configured repo, optionally auto-run the review.
  // Guarded to run exactly once — its callback deps change identity as state updates,
  // and re-running would re-create the session (and re-fire the AI call) in a loop.
  const smokeRan = useRef(false);
  useEffect(() => {
    const smoke = window.margin.smokeConfig();
    if (!smoke?.repo || smokeRan.current) return;
    smokeRan.current = true;
    window.margin.openRepo(smoke.repo).then((repo) => {
      if (!repo) return;
      setRepos([repo]);
      const session: Session = {
        key: crypto.randomUUID(),
        createdAt: Date.now(),
        repoPath: repo.path,
        repoName: repo.name,
        baseRef: smoke.base,
        headRef: smoke.head || null,
        status: 'idle',
        transcript: [],
        findings: [],
        changeSummary: '',
        costUsd: null,
        modelChoice: smoke.model || undefined,
        ...(smoke.finding
          ? {
              status: 'done' as const,
              changeSummary: 'Adds an off-by-one to the cart total.',
              findings: [
                {
                  file: 'cart.js',
                  line: 3,
                  severity: 'high' as const,
                  category: 'correctness' as const,
                  summary: 'Off-by-one skips the last item.',
                  failureScenario: 'Checkout with 3 items charges for 2.',
                  snippet: '  for (let i = 0; i < items.length - 1; i++) {',
                },
              ],
            }
          : {}),
      };
      setSessions([session]);
      setActiveKey(session.key);
      if (smoke.run) {
        runReview(session).then((result) => {
          if (result && smoke.chat) {
            // Smoke chat lands on the first finding's thread so it's visible in the screenshot.
            sendChatCore(session.key, result.sessionId, result.workDir, smoke.chat, smoke.chat, 0);
          }
        });
      } else if (smoke.comment) {
        // Exercise the lazy-session path: comment on a line with no review run.
        window.margin.changedFiles(targetOf(session)).then((files) => {
          const file =
            (smoke.commentFile ? files.find((f) => f.path.includes(smoke.commentFile)) : undefined) ??
            files.find((f) => f.path.endsWith('.js')) ??
            files[0];
          if (file) {
            // Late re-select: the session's own file-load effect races this and would win with files[0].
            setTimeout(() => setSelectedFile(file.path), 600);
            const line = smoke.commentLine || 20;
            // Quote the real line, like the UI does — a comment with no quoted
            // source can't re-anchor, so an empty one wouldn't exercise the path.
            window.margin.fileDiff(targetOf(session), file.path).then((d) => {
              const quoted = d.newContent.split('\n')[line - 1] ?? '';
              addComment(session, file.path, 'new', line, line, quoted, smoke.comment, {
                external: smoke.external || undefined,
              });
            });
          }
        });
      }
    });
  }, [runReview, sendChatCore, addComment]);

  // Findings filtered by the repo's dismissal memory (original indices preserved for threads).
  const activeDismissals = (active && dismissals[active.repoPath]) ?? [];
  const dismissedKeys = useMemo(() => new Set(activeDismissals.map(dismissalKey)), [activeDismissals]);
  const storedFindings = active?.findings ?? [];

  /**
   * Findings with the open file's anchors corrected against its current content.
   * Order and length are preserved — per-finding chat threads are keyed by index.
   * Display-only: the session keeps the review-time line, so re-deriving is
   * idempotent instead of compounding.
   */
  const activeFindings = useMemo(() => {
    const content = openDiff?.newContent;
    if (!content) return storedFindings;
    return storedFindings.map((f) => {
      if (f.file !== openDiff.path) return f;
      const at = reanchor(content, { startLine: f.line, endLine: f.line }, f.snippet);
      return at.startLine === f.line ? f : { ...f, line: at.startLine };
    });
  }, [storedFindings, openDiff]);

  const fileFindings = useMemo(
    () =>
      activeFindings.filter(
        (f) => f.file === selectedFile && !dismissedKeys.has(dismissalKey(f)) && f.verdict !== 'refuted',
      ),
    [activeFindings, selectedFile, dismissedKeys],
  );
  const flaggedFiles = useMemo(() => new Set(activeFindings.map((f) => f.file)), [activeFindings]);

  /** Comment threads for the open file, re-anchored the same way. */
  const fileComments = useMemo(() => {
    const mine = (active?.comments ?? []).filter((c) => c.file === selectedFile);
    if (!openDiff) return mine;
    return mine.map((c) => {
      const content = c.side === 'old' ? openDiff.oldContent : openDiff.newContent;
      if (!content) return c;
      const at = reanchor(content, c, c.quoted);
      return at.startLine === c.startLine && at.endLine === c.endLine ? c : { ...c, ...at };
    });
  }, [active?.comments, selectedFile, openDiff]);
  const conversationFiles = useMemo(() => conversationStates(active?.comments ?? []), [active?.comments]);

  // Which outboxes main should poll — only sessions with a request actually out,
  // so an idle app polls nothing. Registered by signature rather than array
  // identity: `sessions` gets a new object on every state change, and
  // re-registering restarts the poll.
  const awaitingSessions = useMemo(
    () => sessions.filter(hasPendingBridgeWork).map(bridgeSessionOf),
    [sessions],
  );
  const watchSignature = awaitingSessions.map((s) => `${s.key}|${s.repoPath}|${s.baseRef}|${s.headRef}`).join('\n');
  useEffect(() => {
    window.margin.bridgeWatch(awaitingSessions).catch(() => {});
  }, [watchSignature]);

  // Resolving the bridge directory also creates it, so it happens on demand —
  // nothing lands in app data for a session that never uses the bridge.
  const resolveBridgeDir = useCallback(
    () => (active ? window.margin.bridgeDir(bridgeSessionOf(active)) : Promise.reject(new Error('no session'))),
    [active],
  );

  /**
   * One finding thread, rendered identically wherever it appears — the findings
   * panel and the inline card in the diff are the same component with the same
   * handlers, so an action can't exist in one place and not the other.
   *
   * The index is looked up rather than passed: the diff's findings are filtered to
   * one file and re-anchored, so its callers have no index to give.
   */
  const renderFindingThread = useCallback(
    (session: Session, finding: Finding, inline = false) => {
      const id = findingItemId(finding);
      const index = session.findings.findIndex((f) => findingItemId(f) === id);
      const scope = chatScope[session.key];
      return (
        <FindingThread
          key={id}
          finding={finding}
          inline={inline}
          thread={session.threads?.[index] ?? []}
          busy={!!chatBusy[session.key]}
          collapsed={!!session.collapsedFindings?.[dismissalKey(finding)]}
          onToggleCollapse={() => toggleCollapseFinding(session, finding)}
          streaming={scope?.type === 'finding' && scope.index === index ? streamText[session.key] ?? '' : undefined}
          onJump={() => setSelectedFile(finding.file)}
          onDismiss={() => dismissFinding(session, finding)}
          onReply={(text) => sendChat(session, text, index)}
          onProposeFix={() => proposeFix(session, index)}
          pending={session.pendingFindings?.[id] != null}
          onHandOff={() => handOffFinding(session, finding)}
          onStopWaiting={() => stopWaitingFinding(session, finding)}
          resolveBridgeDir={resolveBridgeDir}
          onApplyPatch={(patch) => applyPatch(session, patch, index)}
        />
      );
    },
    [
      chatBusy,
      chatScope,
      streamText,
      toggleCollapseFinding,
      dismissFinding,
      sendChat,
      proposeFix,
      handOffFinding,
      stopWaitingFinding,
      resolveBridgeDir,
      applyPatch,
    ],
  );

  const activeScope = active ? chatScope[active.key] : undefined;
  const activeStream = active ? streamText[active.key] ?? '' : '';
  const deltaAvailable = !!(active?.lastReviewedSha && active.headRef && active.status === 'done');

  if (booting) {
    return (
      <div className="app">
        <div className="boot-splash">
          <span className="boot-mark">Margin</span>
        </div>
      </div>
    );
  }

  return (
    // The topbar spans the window and everything else sits under it, so the
    // sidebar starts below the header the same way the findings panel does.
    <div className={active ? 'app has-topbar' : 'app'}>
      {active && (
        <header className="topbar">
          <div className="topbar-title">
            <span className="repo-name">{active.repoName}</span>
            <span className="session-name">{sessionTitle(active)}</span>
            <span className="base-ref">vs {active.baseRef}</span>
          </div>
          <div className="topbar-actions">
            <label className="labelled-select">
              model
              <select
                className="model-select"
                title="Model for reviews, session chat and finding threads — line comments handed to your agent don't use it"
                value={active.modelChoice ?? ''}
                onChange={(e) => patchSession(active.key, { modelChoice: e.target.value || undefined })}
              >
                <option value="">default</option>
                <option value="claude-fable-5">fable</option>
                <option value="opus">opus</option>
                <option value="sonnet">sonnet</option>
                <option value="haiku">haiku</option>
              </select>
            </label>
            {deltaAvailable && (
              <button
                className="icon-btn"
                title="Re-review the full diff from scratch"
                disabled={active.status === 'reviewing'}
                onClick={() => runReview(active, 'full')}
              >
                full re-review
              </button>
            )}
            <button
              className="run-btn"
              disabled={active.status === 'reviewing'}
              onClick={() => runReview(active, deltaAvailable ? 'delta' : 'full')}
            >
              {active.status === 'reviewing'
                ? 'Reviewing…'
                : deltaAvailable
                  ? 'Review new changes'
                  : active.status === 'done'
                    ? 'Re-review'
                    : 'Run review'}
            </button>
          </div>
        </header>
      )}
      <div className="app-body">
      <Sidebar
        collapsed={sidebarHidden}
        width={sidebarPanel.width}
        repos={repos}
        sessions={sessions}
        activeKey={activeKey}
        onAddRepo={addRepo}
        onNewSession={newSession}
        onSelectSession={setActiveKey}
        onDeleteSession={deleteSession}
        onRefreshSession={refreshSession}
        activeCommits={branchCommits}
        onRemoveRepo={removeRepo}
        onRefreshRepo={refreshRepo}
        onEditInstructions={setInstructionsRepo}
        onOpenSettings={() => {
          console.log('[margin] settings opened via gear click');
          setSettingsOpen(true);
        }}
        onToggleCollapse={sidebarCollapsed.toggle}
        canCollapse={active !== null}
      />
      {/* Nothing to drag when it's a rail. */}
      {!sidebarHidden && <ResizeHandle onMouseDown={sidebarPanel.startDrag} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {instructionsRepo && <InstructionsModal repo={instructionsRepo} onClose={() => setInstructionsRepo(null)} />}
      {active ? (
        <main className="main">
          <div className="workspace">
            <nav className="filelist" style={{ width: filesPanel.width }}>
              <FileList
                files={files}
                selected={selectedFile}
                flagged={flaggedFiles}
                conversations={conversationFiles}
                onSelect={setSelectedFile}
                onRevealConversation={(path) => {
                  setSelectedFile(path);
                  setRevealConvo((n) => n + 1);
                }}
              />
            </nav>
            <ResizeHandle onMouseDown={filesPanel.startDrag} />
            <section className="diffpane">
              {selectedFile ? (
                <DiffPane
                  target={targetOf(active)}
                  path={selectedFile}
                  diff={openDiff}
                  error={openDiffError}
                  reloadKey={diffReloadKey}
                  revealConvo={revealConvo}
                  generated={files.find((f) => f.path === selectedFile)?.generated}
                  findings={fileFindings}
                  comments={fileComments}
                  agents={agentNames}
                  defaultAnswerer={defaultAnswerer}
                  themeMode={themeMode}
                  busy={!!chatBusy[active.key]}
                  streamScope={activeScope}
                  streamText={activeStream}
                  onAddComment={(file, side, startLine, endLine, quoted, text, answerer) =>
                    addComment(active, file, side, startLine, endLine, quoted, text, answerer)
                  }
                  resolveBridgeDir={resolveBridgeDir}
                  renderFinding={(f) => renderFindingThread(active, f, true)}
                  onReplyComment={(comment, text) => replyComment(active, comment, text)}
                  onHandOff={(comment) => handOff(active, comment)}
                  onStopWaiting={(comment) => stopWaiting(active, comment)}
                  onToggleCollapse={(comment) => toggleCollapseComment(active, comment.id)}
                  onToggleResolve={(comment) => toggleResolveComment(active, comment.id)}
                  onDeleteComment={(comment) => deleteComment(active, comment)}
                  onApplyPatch={(patch, commentId) => applyPatchToComment(active, patch, commentId)}
                />
              ) : (
                <div className="empty-note">Select a file</div>
              )}
            </section>
            {/* Nothing to drag when it's a rail. */}
            {!reviewCollapsed.collapsed && <ResizeHandle onMouseDown={reviewPanel.startDrag} />}
            <ReviewPanel
              width={reviewPanel.width}
              collapsed={reviewCollapsed.collapsed}
              onToggleCollapse={reviewCollapsed.toggle}
              // Anchored findings, so the panel's line numbers match the diff's.
              session={{ ...active, findings: activeFindings }}
              busy={!!chatBusy[active.key]}
              streamScope={activeScope}
              streamText={activeStream}
              dismissedKeys={dismissedKeys}
              dismissals={activeDismissals}
              onRestore={(key) => restoreDismissal(active.repoPath, key)}
              onSendChat={(text, findingIndex) => sendChat(active, text, findingIndex)}
              renderFinding={(f) => renderFindingThread(active, f)}
              onApplyPatch={(patch, findingIndex) => applyPatch(active, patch, findingIndex)}
            />
          </div>
        </main>
      ) : (
        <main className="main main-empty">
          <div className="hero">
            <h1>Margin</h1>
            <p>Local AI code review. Add a repository, pick a branch or your uncommitted changes, and run a review.</p>
            <button className="run-btn" onClick={addRepo}>Add repository</button>
          </div>
        </main>
      )}
      </div>
    </div>
  );
}
