import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangedFile,
  ChatMessage,
  Comment,
  DismissedFinding,
  Finding,
  RepoInfo,
  ReviewTarget,
  Session,
} from '../../shared/ipc.js';

/** Which thread the in-flight chat turn belongs to, for routing streamed text. */
export type ChatScope = { type: 'chat' } | { type: 'finding'; index: number } | { type: 'comment'; id: string };

export function dismissalKey(d: Pick<DismissedFinding, 'file' | 'category' | 'summary'>): string {
  return `${d.file}::${d.category}::${d.summary}`;
}
import { Sidebar } from './components/Sidebar.js';
import { SettingsModal } from './components/SettingsModal.js';
import { InstructionsModal } from './components/InstructionsModal.js';
import { DiffPane } from './components/DiffPane.js';
import { ReviewPanel } from './components/ReviewPanel.js';
import { FileList, conversationStates } from './components/FileList.js';
import { ResizeHandle, usePanelWidth } from './components/Resizer.js';

export type { Session };

export function targetOf(s: Session): ReviewTarget {
  return { repoPath: s.repoPath, baseRef: s.baseRef, headRef: s.headRef };
}

export function sessionTitle(s: Session): string {
  return s.headRef ?? 'uncommitted changes';
}

export function App() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState<Record<string, boolean>>({});
  const [streamText, setStreamText] = useState<Record<string, string>>({});
  const [chatScope, setChatScope] = useState<Record<string, ChatScope>>({});
  const [dismissals, setDismissals] = useState<Record<string, DismissedFinding[]>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [instructionsRepo, setInstructionsRepo] = useState<RepoInfo | null>(null);
  const loaded = useRef(false);

  const sidebarPanel = usePanelWidth('sidebar', 230, 160, 480, 1);
  const filesPanel = usePanelWidth('filelist', 220, 150, 520, 1);
  const reviewPanel = usePanelWidth('review', 340, 260, 720, -1);

  const active = useMemo(() => sessions.find((s) => s.key === activeKey) ?? null, [sessions, activeKey]);

  // Load persisted JSON state once on startup (skipped in smoke mode, which seeds its own).
  useEffect(() => {
    if (window.margin.smokeConfig()) {
      loaded.current = true;
      return;
    }
    window.margin.loadState().then((state) => {
      setRepos(state.repos);
      setSessions(state.sessions);
      loaded.current = true;
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
        setSelectedFile(f[0]?.path ?? null);
      })
      .catch(() => setFiles([]));
    return () => {
      cancelled = true;
    };
  }, [activeKey, active?.repoPath, active?.baseRef, active?.headRef]);

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
      sdkSessionId: string,
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
    (session: Session, text: string, findingIndex?: number) => {
      if (!session.sdkSessionId || !session.workDir || chatBusy[session.key]) return;
      let prompt = text;
      if (findingIndex != null) {
        const f = session.findings[findingIndex];
        prompt = `Regarding your review finding "${f.summary}" at ${f.file}:${f.line}:\n\n${text}`;
      }
      sendChatCore(session.key, session.sdkSessionId, session.workDir, text, prompt, findingIndex, session.modelChoice);
    },
    [sendChatCore, chatBusy],
  );

  const proposeFix = useCallback(
    (session: Session, findingIndex: number) => {
      if (!session.sdkSessionId || !session.workDir || chatBusy[session.key]) return;
      const f = session.findings[findingIndex];
      const prompt =
        `Propose a minimal fix for your review finding "${f.summary}" at ${f.file}:${f.line}. ` +
        'Reply with a one-paragraph explanation followed by exactly ONE unified diff inside a ```diff code fence, ' +
        'using a/ b/ path prefixes so it applies cleanly with `git apply` from the repo root. No other code blocks.';
      sendChatCore(session.key, session.sdkSessionId, session.workDir, 'Propose a fix', prompt, findingIndex, session.modelChoice);
    },
    [sendChatCore, chatBusy],
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
    async (session: Session, commentId: string, prompt: string) => {
      setChatBusy((b) => ({ ...b, [session.key]: true }));
      setChatScope((p) => ({ ...p, [session.key]: { type: 'comment', id: commentId } }));
      setStreamText((p) => ({ ...p, [session.key]: '' }));
      try {
        // Comments work before any review ran: lazily prepare a workdir and
        // let chat() start a fresh session when there's nothing to resume.
        const workDir = session.workDir ?? (await window.margin.prepareWorkdir(targetOf(session)));
        const reply = await window.margin.sendChat(session.key, session.sdkSessionId ?? null, workDir, prompt, {
          model: session.modelChoice,
          repoPath: session.repoPath,
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
    [appendToComment, patchSession],
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
    ) => {
      if (chatBusy[session.key]) return;
      const comment: Comment = {
        id: crypto.randomUUID(),
        file,
        side,
        startLine,
        endLine,
        messages: [{ role: 'user', text, at: Date.now() }],
      };
      patchSession(session.key, (s) => ({ comments: [...(s.comments ?? []), comment] }));
      const lineDesc = startLine === endLine ? `line ${endLine}` : `lines ${startLine}-${endLine}`;
      const prompt =
        `The user commented on ${file}, ${lineDesc} (${side === 'old' ? 'old/removed side of the diff' : 'new version'}).` +
        (quoted ? `\nThe line(s) read:\n\`\`\`\n${quoted}\n\`\`\`` : '') +
        `\nChangeset under review: ${session.baseRef}...${session.headRef ?? 'working tree'}.\n\n${text}`;
      runCommentTurn(session, comment.id, prompt);
    },
    [chatBusy, patchSession, runCommentTurn],
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
    (session: Session, commentId: string) => {
      if (!window.confirm('Delete this comment thread?')) return;
      patchSession(session.key, (s) => ({
        comments: (s.comments ?? []).filter((c) => c.id !== commentId),
      }));
    },
    [patchSession],
  );

  const replyComment = useCallback(
    (session: Session, comment: Comment, text: string) => {
      if (chatBusy[session.key]) return;
      appendToComment(session.key, comment.id, { role: 'user', text, at: Date.now() });
      const prompt = `Continuing the comment thread on ${comment.file}:${comment.endLine} (${comment.side} side):\n\n${text}`;
      runCommentTurn(session, comment.id, prompt);
    },
    [chatBusy, appendToComment, runCommentTurn],
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
            addComment(session, file.path, 'new', line, line, '', smoke.comment);
          }
        });
      }
    });
  }, [runReview, sendChatCore, addComment]);

  // Findings filtered by the repo's dismissal memory (original indices preserved for threads).
  const activeDismissals = (active && dismissals[active.repoPath]) ?? [];
  const dismissedKeys = useMemo(() => new Set(activeDismissals.map(dismissalKey)), [activeDismissals]);
  const activeFindings = active?.findings ?? [];
  const fileFindings = useMemo(
    () =>
      activeFindings.filter(
        (f) => f.file === selectedFile && !dismissedKeys.has(dismissalKey(f)) && f.verdict !== 'refuted',
      ),
    [activeFindings, selectedFile, dismissedKeys],
  );
  const flaggedFiles = useMemo(() => new Set(activeFindings.map((f) => f.file)), [activeFindings]);
  const fileComments = useMemo(
    () => (active?.comments ?? []).filter((c) => c.file === selectedFile),
    [active?.comments, selectedFile],
  );
  const conversationFiles = useMemo(() => conversationStates(active?.comments ?? []), [active?.comments]);
  const activeScope = active ? chatScope[active.key] : undefined;
  const activeStream = active ? streamText[active.key] ?? '' : '';
  const deltaAvailable = !!(active?.lastReviewedSha && active.headRef && active.status === 'done');

  return (
    <div className="app">
      <Sidebar
        width={sidebarPanel.width}
        repos={repos}
        sessions={sessions}
        activeKey={activeKey}
        onAddRepo={addRepo}
        onNewSession={newSession}
        onSelectSession={setActiveKey}
        onDeleteSession={deleteSession}
        onRemoveRepo={removeRepo}
        onRefreshRepo={refreshRepo}
        onEditInstructions={setInstructionsRepo}
        onOpenSettings={() => {
          console.log('[margin] settings opened via gear click');
          setSettingsOpen(true);
        }}
      />
      <ResizeHandle onMouseDown={sidebarPanel.startDrag} />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {instructionsRepo && <InstructionsModal repo={instructionsRepo} onClose={() => setInstructionsRepo(null)} />}
      {active ? (
        <main className="main">
          <header className="topbar">
            <div className="topbar-title">
              <span className="repo-name">{active.repoName}</span>
              <span className="session-name">{sessionTitle(active)}</span>
              <span className="base-ref">vs {active.baseRef}</span>
            </div>
            <div className="topbar-actions">
              <select
                className="model-select"
                title="Model for reviews and chat in this session"
                value={active.modelChoice ?? ''}
                onChange={(e) => patchSession(active.key, { modelChoice: e.target.value || undefined })}
              >
                <option value="">default model</option>
                <option value="claude-fable-5">fable</option>
                <option value="opus">opus</option>
                <option value="sonnet">sonnet</option>
                <option value="haiku">haiku</option>
              </select>
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
          <div className="workspace">
            <nav className="filelist" style={{ width: filesPanel.width }}>
              <FileList
                files={files}
                selected={selectedFile}
                flagged={flaggedFiles}
                conversations={conversationFiles}
                onSelect={setSelectedFile}
              />
            </nav>
            <ResizeHandle onMouseDown={filesPanel.startDrag} />
            <section className="diffpane">
              {selectedFile ? (
                <DiffPane
                  target={targetOf(active)}
                  path={selectedFile}
                  findings={fileFindings}
                  comments={fileComments}
                  busy={!!chatBusy[active.key]}
                  streamScope={activeScope}
                  streamText={activeStream}
                  onAddComment={(file, side, startLine, endLine, quoted, text) =>
                    addComment(active, file, side, startLine, endLine, quoted, text)
                  }
                  onReplyComment={(comment, text) => replyComment(active, comment, text)}
                  onToggleCollapse={(comment) => toggleCollapseComment(active, comment.id)}
                  onToggleResolve={(comment) => toggleResolveComment(active, comment.id)}
                  onDeleteComment={(comment) => deleteComment(active, comment.id)}
                  collapsedFindings={active.collapsedFindings ?? {}}
                  onToggleFinding={(f) => toggleCollapseFinding(active, f)}
                  onApplyPatch={(patch, commentId) => applyPatchToComment(active, patch, commentId)}
                />
              ) : (
                <div className="empty-note">Select a file</div>
              )}
            </section>
            <ResizeHandle onMouseDown={reviewPanel.startDrag} />
            <ReviewPanel
              width={reviewPanel.width}
              session={active}
              busy={!!chatBusy[active.key]}
              streamScope={activeScope}
              streamText={activeStream}
              dismissedKeys={dismissedKeys}
              dismissals={activeDismissals}
              collapsedFindings={active.collapsedFindings ?? {}}
              onToggleFinding={(f) => toggleCollapseFinding(active, f)}
              onDismiss={(f) => dismissFinding(active, f)}
              onRestore={(key) => restoreDismissal(active.repoPath, key)}
              onJumpToFinding={(f: Finding) => setSelectedFile(f.file)}
              onSendChat={(text, findingIndex) => sendChat(active, text, findingIndex)}
              onProposeFix={(findingIndex) => proposeFix(active, findingIndex)}
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
  );
}
