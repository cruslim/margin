import { contextBridge, ipcRenderer } from 'electron';
import type { MarginApi } from '../shared/ipc.js';

const api: MarginApi = {
  pickRepo: () => ipcRenderer.invoke('repo:pick'),
  openRepo: (path) => ipcRenderer.invoke('repo:open', path),
  changedFiles: (target) => ipcRenderer.invoke('diff:files', target),
  fileDiff: (target, path) => ipcRenderer.invoke('diff:file', target, path),
  runReview: (sessionKey, target) => ipcRenderer.invoke('review:run', sessionKey, target),
  cleanupWorktree: (repoPath, workDir) => ipcRenderer.invoke('worktree:cleanup', repoPath, workDir),
  sendChat: (sessionKey, sdkSessionId, workDir, message) =>
    ipcRenderer.invoke('chat:send', sessionKey, sdkSessionId, workDir, message),
  applyPatch: (repoPath, patch) => ipcRenderer.invoke('patch:apply', repoPath, patch),
  prepareWorkdir: (target) => ipcRenderer.invoke('workdir:prepare', target),
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
        }
      : null,
};

contextBridge.exposeInMainWorld('margin', api);
