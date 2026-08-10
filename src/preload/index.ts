import { contextBridge, ipcRenderer } from 'electron';
import type { MarginApi } from '../shared/ipc.js';

const api: MarginApi = {
  pickRepo: () => ipcRenderer.invoke('repo:pick'),
  openRepo: (path) => ipcRenderer.invoke('repo:open', path),
  changedFiles: (target) => ipcRenderer.invoke('diff:files', target),
  branchCommits: (target) => ipcRenderer.invoke('git:commits', target),
  refState: (target) => ipcRenderer.invoke('git:refState', target),
  fileDiff: (target, path) => ipcRenderer.invoke('diff:file', target, path),
  runReview: (sessionKey, target, opts) => ipcRenderer.invoke('review:run', sessionKey, target, opts),
  onChatDelta: (cb) => {
    const listener = (_e: unknown, sessionKey: string, delta: string) => cb(sessionKey, delta);
    ipcRenderer.on('chat:delta', listener);
    return () => ipcRenderer.removeListener('chat:delta', listener);
  },
  listDismissals: (repoPath) => ipcRenderer.invoke('dismissals:list', repoPath),
  addDismissal: (repoPath, d) => ipcRenderer.invoke('dismissals:add', repoPath, d),
  removeDismissal: (repoPath, key) => ipcRenderer.invoke('dismissals:remove', repoPath, key),
  cleanupWorktree: (repoPath, workDir) => ipcRenderer.invoke('worktree:cleanup', repoPath, workDir),
  sendChat: (sessionKey, sdkSessionId, workDir, message, opts) =>
    ipcRenderer.invoke('chat:send', sessionKey, sdkSessionId, workDir, message, opts),
  applyPatch: (repoPath, patch) => ipcRenderer.invoke('patch:apply', repoPath, patch),
  bridgeDir: (session) => ipcRenderer.invoke('bridge:dir', session),
  bridgeSubmit: (session, turn) => ipcRenderer.invoke('bridge:submit', session, turn),
  bridgeWithdraw: (session, threadId, turn) => ipcRenderer.invoke('bridge:withdraw', session, threadId, turn),
  bridgeWatch: (sessions) => ipcRenderer.invoke('bridge:watch', sessions),
  onBridgeReply: (cb) => {
    const listener = (_e: unknown, sessionKey: string, threadId: string, text: string) =>
      cb(sessionKey, threadId, text);
    ipcRenderer.on('bridge:reply', listener);
    return () => ipcRenderer.removeListener('bridge:reply', listener);
  },
  getRepoInstructions: (repoPath) => ipcRenderer.invoke('instructions:get', repoPath),
  saveRepoInstructions: (repoPath, text) => ipcRenderer.invoke('instructions:save', repoPath, text),
  ensureWorkdir: (target, workDir) => ipcRenderer.invoke('workdir:ensure', target, workDir),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  openSettingsFile: () => ipcRenderer.invoke('settings:openFile'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  loadState: () => ipcRenderer.invoke('storage:load'),
  saveRepo: (repo) => ipcRenderer.invoke('storage:saveRepo', repo),
  saveSessions: (sessions) => ipcRenderer.invoke('storage:saveSessions', sessions),
  deleteSession: (session) => ipcRenderer.invoke('storage:deleteSession', session),
  removeRepoData: (repoPath) => ipcRenderer.invoke('storage:removeRepo', repoPath),
  onReviewProgress: (cb) => {
    const listener = (_e: unknown, sessionKey: string, line: string) => cb(sessionKey, line);
    ipcRenderer.on('review:progress', listener);
    return () => ipcRenderer.removeListener('review:progress', listener);
  },
  smokeConfig: () =>
    process.env.MARGIN_SMOKE
      ? {
          repo: process.env.MARGIN_SMOKE_REPO ?? '',
          base: process.env.MARGIN_SMOKE_BASE ?? 'main',
          head: process.env.MARGIN_SMOKE_HEAD ?? '',
          run: !!process.env.MARGIN_SMOKE_RUN,
          chat: process.env.MARGIN_SMOKE_CHAT ?? '',
          comment: process.env.MARGIN_SMOKE_COMMENT ?? '',
          commentFile: process.env.MARGIN_SMOKE_COMMENT_FILE ?? '',
          commentLine: Number(process.env.MARGIN_SMOKE_COMMENT_LINE) || 0,
          model: process.env.MARGIN_SMOKE_MODEL ?? '',
          // Start the session in external agent mode: the comment goes to the
          // file bridge, so the flow can be driven without spending an AI call.
          external: !!process.env.MARGIN_SMOKE_EXTERNAL,
          // Seed one finding into the smoke session. Findings normally only exist
          // after a real review, which would make the handoff path untestable
          // without spending a call.
          finding: !!process.env.MARGIN_SMOKE_FINDING,
        }
      : null,
};

contextBridge.exposeInMainWorld('margin', api);
