import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import fixPath from 'fix-path';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';

// Apps launched from Finder get a minimal PATH; the review engine spawns
// `node` for the SDK CLI, so restore the user's shell PATH first.
fixPath();

// fix-path needs a resolvable $SHELL; as a deterministic fallback, probe the
// usual node install locations (nvm, homebrew, volta, n) and prepend the
// first hit to PATH.
function ensureNodeOnPath(): void {
  try {
    execFileSync('node', ['--version'], { stdio: 'ignore' });
    return;
  } catch {
    // not on PATH — probe below
  }
  const home = homedir();
  const candidates = ['/opt/homebrew/bin', '/usr/local/bin', join(home, '.volta/bin'), join(home, 'n/bin')];
  try {
    const versions = readdirSync(join(home, '.nvm/versions/node'))
      .map((v) => ({ v, parts: v.replace(/^v/, '').split('.').map(Number) }))
      .sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
    if (versions[0]) candidates.unshift(join(home, '.nvm/versions/node', versions[0].v, 'bin'));
  } catch {
    // no nvm
  }
  for (const dir of candidates) {
    if (existsSync(join(dir, 'node'))) {
      process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
      return;
    }
  }
}
ensureNodeOnPath();

// The CodeRabbit CLI installs to ~/.local/bin, which Finder-launched apps
// won't have on PATH either.
{
  const localBin = join(homedir(), '.local/bin');
  if (existsSync(localBin) && !(process.env.PATH ?? '').includes(localBin)) {
    process.env.PATH = `${process.env.PATH ?? ''}:${localBin}`;
  }
}

// The SDK spawns its CLI with child_process.spawn, which Electron does NOT
// patch for asar — hand it the real unpacked path.
if (app.isPackaged) {
  process.env.MARGIN_CLI_PATH = join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    'claude-agent-sdk',
    'cli.js',
  );
}

// Keep the dev-era storage location (package.json name "margin") — the
// packaged app's productName is "Margin", which would otherwise move
// userData and orphan existing sessions.
app.setPath('userData', join(app.getPath('appData'), 'margin'));
import { openRepo, changedFiles, branchCommits, fileDiff, applyPatch } from './gitService.js';
import { runReview } from '../engine/review.js';
import { toAgentDefinitions } from '../engine/agents.js';
import { chat } from '../engine/chat.js';
import { runBasicReview } from '../engine/basicReview.js';
import { runCodeRabbitReview } from '../engine/coderabbit.js';
import { verifyFindings } from '../engine/verify.js';
import type { Finding } from '../engine/types.js';
import type { AppSettings } from '../shared/ipc.js';
import { createWorktree, removeWorktree } from '../engine/worktree.js';
import { resolveTheme } from '../shared/themes.js';
import * as storage from './storage.js';
import { collectReplies, ensureBridge, itemId, submitTurn, withdrawTurn } from './bridge.js';
import type { ReviewTarget } from '../engine/types.js';
import type { BridgeSession, BridgeTurn, DismissedFinding, RepoInfo, Session } from '../shared/ipc.js';

const isDev = !!process.env.ELECTRON_RENDERER_URL;

function createWindow(backgroundColor: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    title: 'Margin',
    titleBarStyle: 'hiddenInset',
    backgroundColor,
    // Appear fully painted: the first frame is the boot mark, never a blank window.
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
    },
  });
  win.once('ready-to-show', () => win.show());

  if (isDev) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL!);
  } else {
    win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return win;
}

app.whenReady().then(async () => {
  // Paint the window in the active theme's background from the first frame.
  const themeBg = resolveTheme((await storage.loadSettings().catch(() => undefined))?.themes).colors.bg;
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
  ipcMain.handle('git:commits', (_e, target: ReviewTarget) => branchCommits(target));
  ipcMain.handle('diff:file', (_e, target: ReviewTarget, path: string) => fileDiff(target, path));

  ipcMain.handle('settings:get', () => storage.loadSettings());
  ipcMain.handle('settings:openFile', async () => {
    // Materialize the file with current values first — it may not exist yet,
    // and a fresh copy gives the editor every key (defaults included).
    await storage.saveSettings(await storage.loadSettings());
    // openPath reports failure as a returned string, not a rejection.
    const openError = await shell.openPath(storage.settingsFilePath());
    if (openError) throw new Error(openError);
  });
  ipcMain.handle('settings:save', (_e, settings: AppSettings) => storage.saveSettings(settings));
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

  const captureAndQuit = async (win: BrowserWindow, delayMs: number, reason = 'unknown') => {
    console.log(`capture scheduled (+${delayMs}ms) from: ${reason}`);
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
    const instructions = await storage.getRepoInstructions(target.repoPath);
    const settings = await storage.loadSettings();
    const progress = (line: string) => {
      if (!sender.isDestroyed()) sender.send('review:progress', sessionKey, line);
    };
    try {
      // Extra finders run in parallel with the agentic review; each is
      // best-effort — a failed finder becomes a transcript line, not a
      // failed review.
      const extraFinders: Array<Promise<{ findings: Finding[] }>> = [];
      const finderNames: string[] = [];
      if (settings.openai.enabled && settings.openai.model) {
        finderNames.push(settings.openai.model);
        extraFinders.push(runBasicReview(target, settings.openai, { ...opts, dismissed, instructions }, progress));
      }
      if (settings.coderabbit.enabled) {
        finderNames.push('coderabbit');
        extraFinders.push(runCodeRabbitReview(target, progress));
      }

      const [main, extras] = await Promise.all([
        runReview(target, { onProgress: progress }, { ...opts, dismissed, instructions }),
        Promise.allSettled(extraFinders),
      ]);

      const extraFindings: Finding[] = [];
      extras.forEach((r, i) => {
        if (r.status === 'fulfilled') extraFindings.push(...r.value.findings);
        else progress(`[${finderNames[i]}] failed: ${String(r.reason).slice(0, 200)}`);
      });
      let findings = [...main.findings, ...extraFindings];
      let costUsd = main.costUsd;

      if (settings.verifier.enabled && findings.length > 0) {
        progress(`[verifier] cross-examining ${findings.length} finding(s)`);
        try {
          const verified = await verifyFindings(
            target,
            findings,
            { model: settings.verifier.model || opts?.model },
            progress,
          );
          findings = verified.findings;
          costUsd = (costUsd ?? 0) + (verified.costUsd ?? 0);
        } catch (err) {
          progress(`[verifier] failed: ${String(err).slice(0, 200)} — findings left unverified`);
        }
      }
      return { ...main, findings, costUsd };
    } finally {
      // In auto-run smoke mode, capture after the review settles into the UI
      // (unless a smoke chat turn follows — then capture after that instead).
      if (process.env.MARGIN_SMOKE_RUN && !process.env.MARGIN_SMOKE_CHAT) {
        const win = BrowserWindow.fromWebContents(sender)!;
        if (process.env.MARGIN_SMOKE_LOGTAB) {
          setTimeout(() => {
            win.webContents.executeJavaScript(`
              [...document.querySelectorAll('.panel-tabs button')].find((b) => b.textContent === 'Agent log')?.click();
              setTimeout(() => {
                [...document.querySelectorAll('.log-pill')].find((b) => b.textContent.includes('${process.env.MARGIN_SMOKE_LOGTAB}'))?.click();
              }, 300);
            `).catch(() => {});
          }, 1200);
        }
        if (process.env.MARGIN_SMOKE_CLICK) {
          setTimeout(() => {
            win.webContents.executeJavaScript(`
              [...document.querySelectorAll('button')].find((b) => b.textContent.includes('${process.env.MARGIN_SMOKE_CLICK}'))?.click();
            `).catch(() => {});
          }, 1500);
        }
        if (process.env.MARGIN_SMOKE_COLLAPSE) {
          setTimeout(() => {
            win.webContents.executeJavaScript(`document.querySelector('.finding-head.toggleable')?.click()`).catch(() => {});
          }, 1500);
        }
        // Same hook the chat/comment path exposes, so a review can be driven too.
        if (process.env.MARGIN_SMOKE_JS) {
          setTimeout(() => {
            win.webContents.executeJavaScript(process.env.MARGIN_SMOKE_JS!).catch(() => {});
          }, 1500);
        }
        captureAndQuit(win, 4000, 'review:run finally');
      }
    }
  });

  // Validate a session's workDir before use — macOS reaps temp worktrees after
  // a few days, and spawning the SDK CLI in a missing cwd fails with a
  // misleading "spawn node ENOENT". Recreate the worktree when it's gone.
  ipcMain.handle('workdir:ensure', async (_e, target: ReviewTarget, workDir: string | null) => {
    if (workDir && existsSync(workDir)) return { workDir, recreated: false };
    const fresh = target.headRef ? await createWorktree(target.repoPath, target.headRef) : target.repoPath;
    return { workDir: fresh, recreated: workDir !== null && fresh !== workDir };
  });

  let midstreamCaptured = false;
  ipcMain.handle('chat:send', async (event, sessionKey: string, sdkSessionId: string | null, workDir: string, message: string, opts?: { model?: string; repoPath?: string; agent?: string }) => {
    const sender = event.sender;
    // App-stored instructions key off the real repo path (workDir may be a temp worktree).
    const instructions = opts?.repoPath ? await storage.getRepoInstructions(opts.repoPath) : '';
    const agents = opts?.agent ? toAgentDefinitions((await storage.loadSettings()).agents) : undefined;
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
              captureAndQuit(BrowserWindow.fromWebContents(sender)!, 1500, 'midstream');
            }
          },
        },
        { model: opts?.model, instructions, agents, agent: opts?.agent },
      );
    } finally {
      if (process.env.MARGIN_SMOKE_CHAT || process.env.MARGIN_SMOKE_COMMENT) {
        const win = BrowserWindow.fromWebContents(sender)!;
        if (process.env.MARGIN_SMOKE_COLLAPSE) {
          setTimeout(() => {
            win.webContents.executeJavaScript(
              `document.querySelector('.comment-head')?.click()`,
            ).catch(() => {});
          }, 1500);
        }
        if (process.env.MARGIN_SMOKE_JS) {
          setTimeout(() => {
            win.webContents.executeJavaScript(process.env.MARGIN_SMOKE_JS!).catch(() => {});
          }, 1500);
        }
        captureAndQuit(win, 3000, 'chat:send finally');
      }
    }
  });

  // External agent mode: comments go out as files and replies come back the same
  // way, so nothing here awaits an answer — an agent may take minutes, and a
  // blocking handler would freeze the whole session's chat behind it.
  const watchedBridges = new Map<string, { session: BridgeSession; sender: WebContents }>();
  let bridgePoll: NodeJS.Timeout | null = null;
  let polling = false;

  const pollBridges = async () => {
    // A slow tick must not overlap the next one: two passes over the same outbox
    // could both read a file before either had moved it aside.
    if (polling) return;
    polling = true;
    try {
      for (const [key, watch] of watchedBridges) {
        if (watch.sender.isDestroyed()) {
          watchedBridges.delete(key);
          continue;
        }
        const replies = await collectReplies(storage.bridgeDir(watch.session)).catch(() => []);
        for (const reply of replies) {
          if (!watch.sender.isDestroyed()) watch.sender.send('bridge:reply', key, reply.threadId, reply.text);
        }
      }
    } finally {
      polling = false;
      if (watchedBridges.size === 0 && bridgePoll) {
        clearInterval(bridgePoll);
        bridgePoll = null;
      }
    }
  };

  ipcMain.handle('bridge:watch', (event, sessions: BridgeSession[]) => {
    // The renderer sends its whole set each time, so drop what it registered
    // before rather than accumulating sessions it has since switched back.
    for (const [key, watch] of watchedBridges) {
      if (watch.sender === event.sender) watchedBridges.delete(key);
    }
    for (const session of sessions) watchedBridges.set(session.key, { session, sender: event.sender });
    if (watchedBridges.size > 0 && !bridgePoll) {
      bridgePoll = setInterval(pollBridges, 1500);
      // First pass straight away: it also delivers replies written while the app was closed.
      void pollBridges();
    }
  });

  ipcMain.handle('bridge:dir', async (_e, session: BridgeSession) => ensureBridge(storage.bridgeDir(session)));

  ipcMain.handle('bridge:submit', (_e, session: BridgeSession, turn: BridgeTurn) =>
    submitTurn(storage.bridgeDir(session), itemId(turn.threadId, turn.turn), {
      repoPath: session.repoPath,
      baseRef: session.baseRef,
      headRef: session.headRef,
      file: turn.file,
      side: turn.side,
      startLine: turn.startLine,
      endLine: turn.endLine,
      quoted: turn.quoted,
      messages: turn.messages,
      finding: turn.finding,
    }),
  );

  ipcMain.handle('bridge:withdraw', (_e, session: BridgeSession, threadId: string, turn: number) =>
    withdrawTurn(storage.bridgeDir(session), itemId(threadId, turn)),
  );

  ipcMain.handle('patch:apply', (_e, repoPath: string, patch: string) => applyPatch(repoPath, patch));

  ipcMain.handle('instructions:get', (_e, repoPath: string) => storage.getRepoInstructions(repoPath));
  ipcMain.handle('instructions:save', (_e, repoPath: string, text: string) => storage.saveRepoInstructions(repoPath, text));

  ipcMain.handle('dismissals:list', (_e, repoPath: string) => storage.listDismissals(repoPath));
  ipcMain.handle('dismissals:add', (_e, repoPath: string, d: DismissedFinding) => storage.addDismissal(repoPath, d));
  ipcMain.handle('dismissals:remove', (_e, repoPath: string, key: string) => storage.removeDismissal(repoPath, key));

  const win = createWindow(themeBg);

  if (process.env.MARGIN_SMOKE) {
    win.webContents.on('console-message', (_e, _level, message) => {
      if (message.includes('[margin]')) console.log('renderer:', message);
    });
  }

  // A bridge round-trip — a comment or a finding handed to an external agent — is
  // answered by a poll tick, never by chat:send, so it captures on a timer here
  // rather than off the end of an AI turn, and needs longer to finish.
  const externalComment = !!process.env.MARGIN_SMOKE_COMMENT && !!process.env.MARGIN_SMOKE_EXTERNAL;
  const bridgeSmoke = externalComment || !!process.env.MARGIN_SMOKE_FINDING;

  // Smoke-test mode: load a preconfigured session, screenshot the window, quit.
  // (When RUN/COMMENT are set, the capture is triggered by that flow finishing instead.)
  if (process.env.MARGIN_SMOKE && !process.env.MARGIN_SMOKE_RUN && (!process.env.MARGIN_SMOKE_COMMENT || externalComment)) {
    win.webContents.on('did-finish-load', () => {
      if (process.env.MARGIN_SMOKE_COMPOSER) {
        // Open the line-comment composer by clicking a "+" widget, then capture.
        setTimeout(async () => {
          try {
          const report = await win.webContents.executeJavaScript(`(async () => {
            // Select the source file (first file may be a one-line config diff).
            const fileBtn = [...document.querySelectorAll('.file-item')].find((b) => b.textContent.includes('cart.js'));
            fileBtn?.click();
            await new Promise((r) => setTimeout(r, 1200));
            // Query fresh every time — the diff lib rebuilds its table on re-render,
            // so cached element references go stale.
            const byLine = (n) =>
              [...document.querySelectorAll('span[data-line-num]')].find(
                (el) =>
                  el.getAttribute('data-line-num') === String(n) &&
                  (el.closest('td')?.getAttribute('data-side') === 'new' || el.closest('td')?.className.includes('new-num')),
              );
            const drag = async (a, b) => {
              const s = byLine(a);
              const e = byLine(b);
              if (!s || !e) return false;
              s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, buttons: 1 }));
              e.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, buttons: 1 }));
              e.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
              await new Promise((r) => setTimeout(r, 500));
              return true;
            };
            await drag(15, 20);
            const composer1 = document.querySelector('.range-composer')?.textContent?.slice(0, 30) ?? null;
            // Cancel, then drag a different range.
            const cancelBtn = [...document.querySelectorAll('.range-composer button')].find((b) => b.textContent === 'Cancel');
            cancelBtn?.click();
            await new Promise((r) => setTimeout(r, 500));
            const composerAfterCancel = !!document.querySelector('.range-composer');
            await drag(22, 27);
            const composer2 = document.querySelector('.range-composer')?.textContent?.slice(0, 30) ?? null;
            return {
              composer1,
              composerAfterCancel,
              composer2,
              lit: document.querySelectorAll('tr.margin-range-lit').length,
            };
          })()`);
          console.log('composer smoke:', JSON.stringify(report));
          } catch (err) {
            console.log('composer smoke error:', String(err));
          }
        }, 4000);
        // Same JS hook the other paths expose, run after the composer is open so a
        // test can drive the controls inside it.
        if (process.env.MARGIN_SMOKE_JS) {
          setTimeout(() => {
            win.webContents.executeJavaScript(process.env.MARGIN_SMOKE_JS!).catch(() => {});
          }, 6000);
        }
        captureAndQuit(win, 9000, 'did-finish-load composer');
      } else {
        // Same JS hook the run/comment paths expose, for driving the UI without
        // spending a review or a chat turn.
        if (process.env.MARGIN_SMOKE_JS) {
          setTimeout(() => {
            win.webContents.executeJavaScript(process.env.MARGIN_SMOKE_JS!).catch(() => {});
          }, bridgeSmoke ? 5000 : 3000);
        }
        captureAndQuit(win, bridgeSmoke ? 12000 : 4500, 'did-finish-load plain');
      }
    });
  }
});

app.on('window-all-closed', () => app.quit());
