import { app } from 'electron';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { PersistedState, RepoInfo, Session } from '../shared/ipc.js';
import { openRepo } from './gitService.js';

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

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
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
  // Drop the branch folder if this was its last session.
  const branchDir = join(reviewsRoot(), repoSlug(session.repoPath), branchSlug(session.headRef));
  const left = await readdir(branchDir).catch(() => null);
  if (left && left.length === 0) await rm(branchDir, { recursive: true, force: true });
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
    // Refresh branch list from the live repo; keep stored info if it moved/vanished.
    repos.push((await openRepo(stored.path)) ?? stored);

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
