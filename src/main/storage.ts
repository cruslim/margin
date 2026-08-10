import { app } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AppSettings, DismissedFinding, PersistedState, RepoInfo, Session } from '../shared/ipc.js';
import { DEFAULT_SETTINGS } from '../shared/ipc.js';
import { sanitizeThemeSettings } from '../shared/themes.js';

/**
 * Plain-JSON persistence: one folder per repo, one folder per branch,
 * one file per review session. Everything human-readable and local.
 *
 *   <userData>/reviews/<repo-slug>/repo.json
 *   <userData>/reviews/<repo-slug>/<branch-slug>/session-<key>.json
 */
function reviewsRoot(): string {
  return join(app.getPath('userData'), 'reviews');
}

function repoSlug(repoPath: string): string {
  const hash = createHash('sha1').update(repoPath).digest('hex').slice(0, 6);
  return `${basename(repoPath)}-${hash}`;
}

function branchSlug(headRef: string | null): string {
  return headRef ? headRef.replace(/[^a-zA-Z0-9._-]+/g, '-') : 'working-tree';
}

function sessionFile(session: Session): string {
  return join(
    reviewsRoot(),
    repoSlug(session.repoPath),
    branchSlug(session.headRef),
    `session-${session.key}.json`,
  );
}

/**
 * Where a session's external-agent exchange lives — beside its JSON, so the
 * user's repo stays clean and the bridge files never show up in the diff under
 * review. See main/bridge.ts for what goes inside.
 */
export function bridgeDir(session: Pick<Session, 'key' | 'repoPath' | 'headRef'>): string {
  return join(reviewsRoot(), repoSlug(session.repoPath), branchSlug(session.headRef), `bridge-${session.key}`);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Absolute path of settings.json, for the "open in editor" affordance. */
export function settingsFilePath(): string {
  return settingsFile();
}

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json');
}

export async function loadSettings(): Promise<AppSettings> {
  const stored = await readJson<Partial<AppSettings>>(settingsFile());
  return {
    openai: { ...DEFAULT_SETTINGS.openai, ...stored?.openai },
    coderabbit: { ...DEFAULT_SETTINGS.coderabbit, ...stored?.coderabbit },
    verifier: { ...DEFAULT_SETTINGS.verifier, ...stored?.verifier },
    // Defaults only seed pre-agents settings files; an explicit [] means the
    // user deleted them. Copy the defaults so callers never mutate the shared objects.
    agents: stored?.agents ?? DEFAULT_SETTINGS.agents.map((a) => ({ ...a })),
    // Hand-edited file: anything but a string is not a choice we can honor.
    defaultAnswerer:
      typeof stored?.defaultAnswerer === 'string' ? stored.defaultAnswerer : DEFAULT_SETTINGS.defaultAnswerer,
    // settings.json is hand-editable — normalize instead of trusting the shape.
    themes: sanitizeThemeSettings(stored?.themes),
  };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(settingsFile(), JSON.stringify(settings, null, 2));
}

/**
 * Where the repo picker last landed, so the next one opens there instead of
 * the system default. Its own file rather than a key in settings.json: that
 * one is the user's to hand-edit, this is ours to write behind them.
 *
 *   <userData>/ui-state.json
 */
function uiStateFile(): string {
  return join(app.getPath('userData'), 'ui-state.json');
}

export async function getLastPickDir(): Promise<string | undefined> {
  const stored = await readJson<{ lastPickDir?: unknown }>(uiStateFile());
  return typeof stored?.lastPickDir === 'string' ? stored.lastPickDir : undefined;
}

/** Replaces the file wholesale — it holds this one value and nothing else. */
export async function setLastPickDir(dir: string): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(uiStateFile(), JSON.stringify({ lastPickDir: dir }, null, 2));
}

export async function saveRepo(repo: RepoInfo): Promise<void> {
  const dir = join(reviewsRoot(), repoSlug(repo.path));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'repo.json'), JSON.stringify(repo, null, 2));
}

export async function saveSessions(sessions: Session[]): Promise<void> {
  for (const session of sessions) {
    const file = sessionFile(session);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify({ ...session, transcript: session.transcript.slice(-200) }, null, 2));
  }
}

export async function deleteSession(session: Session): Promise<void> {
  await rm(sessionFile(session), { force: true });
  // Before the emptiness check below — a left-behind bridge folder would keep
  // the branch folder looking occupied forever.
  await rm(bridgeDir(session), { recursive: true, force: true });
  // Drop the branch folder if this was its last session.
  const branchDir = join(reviewsRoot(), repoSlug(session.repoPath), branchSlug(session.headRef));
  const left = await readdir(branchDir).catch(() => null);
  if (left && left.length === 0) await rm(branchDir, { recursive: true, force: true });
}

function dismissalsFile(repoPath: string): string {
  return join(reviewsRoot(), repoSlug(repoPath), 'dismissals.json');
}

export function dismissalKey(d: Pick<DismissedFinding, 'file' | 'category' | 'summary'>): string {
  return `${d.file}::${d.category}::${d.summary}`;
}

export async function listDismissals(repoPath: string): Promise<DismissedFinding[]> {
  return (await readJson<DismissedFinding[]>(dismissalsFile(repoPath))) ?? [];
}

export async function addDismissal(repoPath: string, d: DismissedFinding): Promise<DismissedFinding[]> {
  const all = await listDismissals(repoPath);
  if (!all.some((x) => dismissalKey(x) === dismissalKey(d))) all.push(d);
  await mkdir(join(reviewsRoot(), repoSlug(repoPath)), { recursive: true });
  await writeFile(dismissalsFile(repoPath), JSON.stringify(all, null, 2));
  return all;
}

export async function removeDismissal(repoPath: string, key: string): Promise<DismissedFinding[]> {
  const all = (await listDismissals(repoPath)).filter((x) => dismissalKey(x) !== key);
  await writeFile(dismissalsFile(repoPath), JSON.stringify(all, null, 2)).catch(() => {});
  return all;
}

function instructionsFile(repoPath: string): string {
  return join(reviewsRoot(), repoSlug(repoPath), 'instructions.md');
}

/** User's own review instructions for a repo — stored app-side, removed with the repo's data. */
export async function getRepoInstructions(repoPath: string): Promise<string> {
  try {
    return await readFile(instructionsFile(repoPath), 'utf8');
  } catch {
    return '';
  }
}

export async function saveRepoInstructions(repoPath: string, text: string): Promise<void> {
  if (!text.trim()) {
    await rm(instructionsFile(repoPath), { force: true });
    return;
  }
  await mkdir(join(reviewsRoot(), repoSlug(repoPath)), { recursive: true });
  await writeFile(instructionsFile(repoPath), text);
}

export async function removeRepoData(repoPath: string): Promise<void> {
  await rm(join(reviewsRoot(), repoSlug(repoPath)), { recursive: true, force: true });
}

export async function loadState(): Promise<PersistedState> {
  const repos: RepoInfo[] = [];
  const sessions: Session[] = [];
  const repoDirs = await readdir(reviewsRoot()).catch(() => [] as string[]);

  for (const repoDir of repoDirs) {
    const dir = join(reviewsRoot(), repoDir);
    const stored = await readJson<RepoInfo>(join(dir, 'repo.json'));
    if (!stored) continue;
    // Serve the stored snapshot as-is — startup never waits on git. The
    // renderer refreshes each repo's branch list in the background.
    repos.push(stored);

    for (const branchDir of await readdir(dir).catch(() => [] as string[])) {
      for (const file of await readdir(join(dir, branchDir)).catch(() => [] as string[])) {
        if (!file.startsWith('session-') || !file.endsWith('.json')) continue;
        const session = await readJson<Session>(join(dir, branchDir, file));
        // A session mid-review when the app quit can never finish — mark it stale.
        if (session) sessions.push(session.status === 'reviewing' ? { ...session, status: 'error', error: 'Interrupted by app quit' } : session);
      }
    }
  }

  sessions.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return { repos, sessions };
}
