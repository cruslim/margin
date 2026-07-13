import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { openRepo, changedFiles, fileDiff, applyPatch } from './gitService.js';
import { runReview } from '../engine/review.js';
import { chat } from '../engine/chat.js';
import { createWorktree, removeWorktree } from '../engine/worktree.js';
import * as storage from './storage.js';
import type { ReviewTarget } from '../engine/types.js';
import type { DismissedFinding, RepoInfo, Session } from '../shared/ipc.js';

const isDev = !!process.env.ELECTRON_RENDERER_URL;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    title: 'Margin',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#16161e',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
    },
  });

  if (isDev) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL!);
  } else {
    win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return win;
}

app.whenReady().then(() => {
  ipcMain.handle('repo:pick', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)!;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Choose a git repository',
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return openRepo(result.filePaths[0]);
  });

  ipcMain.handle('repo:open', (_e, path: string) => openRepo(path));
  ipcMain.handle('diff:files', (_e, target: ReviewTarget) => changedFiles(target));
  ipcMain.handle('diff:file', (_e, target: ReviewTarget, path: string) => fileDiff(target, path));

  ipcMain.handle('storage:load', () => storage.loadState());
  ipcMain.handle('storage:saveRepo', (_e, repo: RepoInfo) => storage.saveRepo(repo));
  ipcMain.handle('storage:saveSessions', (_e, sessions: Session[]) => storage.saveSessions(sessions));
  ipcMain.handle('storage:deleteSession', (_e, session: Session) => storage.deleteSession(session));
  ipcMain.handle('storage:removeRepo', (_e, repoPath: string) => storage.removeRepoData(repoPath));

  ipcMain.handle('worktree:cleanup', async (_e, repoPath: string, workDir: string) => {
    // Only ever delete the temp worktrees we created, never the user's repo.
    if (workDir === repoPath || !workDir.startsWith(tmpdir()) || !workDir.includes('margin-')) return;
    await removeWorktree(repoPath, workDir);
  });

  const captureAndQuit = async (win: BrowserWindow, delayMs: number) => {
    setTimeout(async () => {
      const image = await win.webContents.capturePage();
      const out = process.env.MARGIN_SMOKE_OUT ?? '/tmp/margin-smoke.png';
      await writeFile(out, image.toPNG());
      console.log(`smoke screenshot written to ${out}`);
      app.quit();
    }, delayMs);
  };

  ipcMain.handle('review:run', async (event, sessionKey: string, target: ReviewTarget, opts?: { model?: string; sinceSha?: string }) => {
    const sender = event.sender;
    const dismissed = await storage.listDismissals(target.repoPath);
    try {
      return await runReview(
        target,
        {
          onProgress: (line) => {
            if (!sender.isDestroyed()) sender.send('review:progress', sessionKey, line);
          },
        },
        { ...opts, dismissed },
      );
    } finally {
      // In auto-run smoke mode, capture after the review settles into the UI
      // (unless a smoke chat turn follows — then capture after that instead).
      if (process.env.MARGIN_SMOKE_RUN && !process.env.MARGIN_SMOKE_CHAT) {
        captureAndQuit(BrowserWindow.fromWebContents(sender)!, 3000);
      }
    }
  });

  ipcMain.handle('workdir:prepare', (_e, target: ReviewTarget) =>
    target.headRef ? createWorktree(target.repoPath, target.headRef) : target.repoPath,
  );

  let midstreamCaptured = false;
  ipcMain.handle('chat:send', async (event, sessionKey: string, sdkSessionId: string | null, workDir: string, message: string, opts?: { model?: string }) => {
    const sender = event.sender;
    try {
      return await chat(
        sdkSessionId,
        workDir,
        message,
        {
          onProgress: (line) => {
            if (!sender.isDestroyed()) sender.send('review:progress', sessionKey, line);
          },
          onTextDelta: (delta) => {
            if (!sender.isDestroyed()) sender.send('chat:delta', sessionKey, delta);
            // Mid-stream smoke: capture while the reply is streaming in.
            if (process.env.MARGIN_SMOKE_MIDSTREAM && !midstreamCaptured) {
              midstreamCaptured = true;
              captureAndQuit(BrowserWindow.fromWebContents(sender)!, 1500);
            }
          },
        },
        opts ?? {},
      );
    } finally {
      if (process.env.MARGIN_SMOKE_CHAT || process.env.MARGIN_SMOKE_COMMENT) {
        captureAndQuit(BrowserWindow.fromWebContents(sender)!, 3000);
      }
    }
  });

  ipcMain.handle('patch:apply', (_e, repoPath: string, patch: string) => applyPatch(repoPath, patch));

  ipcMain.handle('dismissals:list', (_e, repoPath: string) => storage.listDismissals(repoPath));
  ipcMain.handle('dismissals:add', (_e, repoPath: string, d: DismissedFinding) => storage.addDismissal(repoPath, d));
  ipcMain.handle('dismissals:remove', (_e, repoPath: string, key: string) => storage.removeDismissal(repoPath, key));

  const win = createWindow();

  if (process.env.MARGIN_SMOKE) {
    win.webContents.on('console-message', (_e, _level, message) => {
      if (message.includes('[margin]')) console.log('renderer:', message);
    });
  }

  // Smoke-test mode: load a preconfigured session, screenshot the window, quit.
  // (When RUN/COMMENT are set, the capture is triggered by that flow finishing instead.)
  if (process.env.MARGIN_SMOKE && !process.env.MARGIN_SMOKE_RUN && !process.env.MARGIN_SMOKE_COMMENT) {
    win.webContents.on('did-finish-load', () => {
      if (process.env.MARGIN_SMOKE_COMPOSER) {
        // Open the line-comment composer by clicking a "+" widget, then capture.
        setTimeout(async () => {
          const report = await win.webContents.executeJavaScript(`(async () => {
            // Select the source file (first file may be a one-line config diff).
            const fileBtn = [...document.querySelectorAll('.file-item')].find((b) => b.textContent.includes('cart.js'));
            fileBtn?.click();
            await new Promise((r) => setTimeout(r, 1200));
            const spans = [...document.querySelectorAll('span[data-line-num]')];
            const debug = spans.slice(0, 30).map((el) => el.getAttribute('data-line-num') + '@' + el.closest('td')?.className.split(' ')[0] + '/' + el.closest('td')?.getAttribute('data-side'));
            const byLine = (n) =>
              spans.find(
                (el) =>
                  el.getAttribute('data-line-num') === String(n) &&
                  (el.closest('td')?.getAttribute('data-side') === 'new' || el.closest('td')?.className.includes('new-num')),
              );
            const start = byLine(15);
            const end = byLine(20);
            const fire = (el, type) => {
              const r = el.getBoundingClientRect();
              el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: r.x + 4, clientY: r.y + 4, buttons: 1 }));
            };
            let selecting = false;
            if (start && end) {
              // Simulate a gutter drag from line 15 to 20 — composer bar opens on mouseup.
              fire(start, 'mousedown');
              selecting = !!document.querySelector('.diff-multi-selecting');
              fire(end, 'mouseover');
              fire(end, 'mouseup');
              await new Promise((r) => setTimeout(r, 50));
            }
            const at50 = document.querySelectorAll('.diff-multi-select-active').length;
            const lit50 = document.querySelectorAll('tr.margin-range-lit').length;
            const qNew = document.querySelectorAll('td.diff-line-new-num span[data-line-num]').length;
            await new Promise((r) => setTimeout(r, 700));
            return {
              spans: spans.length,
              selecting,
              at50,
              lit50,
              qNew,
              at750: document.querySelectorAll('.diff-multi-select-active').length,
              lit750: document.querySelectorAll('tr.margin-range-lit').length,
              composer: !!document.querySelector('.range-composer'),
            };
          })()`);
          console.log('composer smoke:', JSON.stringify(report));
        }, 4000);
        captureAndQuit(win, 6000);
      } else {
        captureAndQuit(win, 4500);
      }
    });
  }
});

app.on('window-all-closed', () => app.quit());
