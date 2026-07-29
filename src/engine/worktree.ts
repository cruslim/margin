import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Check out `ref` into a detached temporary worktree so the review session
 * reads a stable snapshot and never touches the user's working copy.
 * The worktree stays alive after the review so chat can keep reading files;
 * call removeWorktree() when the session is closed.
 */
export async function createWorktree(repoPath: string, ref: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'margin-'));
  await git(repoPath, ['worktree', 'add', '--detach', dir, ref]);
  return dir;
}

export async function removeWorktree(repoPath: string, worktreeDir: string): Promise<void> {
  await git(repoPath, ['worktree', 'remove', '--force', worktreeDir]).catch(() => {});
  await rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
}

/** Diff of a branch against its merge-base with baseRef (what a PR would show). */
export async function branchDiff(repoPath: string, baseRef: string, headRef: string): Promise<string> {
  return git(repoPath, ['diff', `${baseRef}...${headRef}`]);
}

/** Untracked (never git-added) files, honoring .gitignore. */
export async function untrackedPaths(repoPath: string): Promise<string[]> {
  const out = await git(repoPath, ['ls-files', '--others', '--exclude-standard', '-z']);
  return out.split('\0').filter(Boolean);
}

/**
 * New-file diff for an untracked path — plain `git diff` never shows untracked
 * files. `--no-index` against /dev/null renders a proper new-file diff,
 * including binary detection and no-newline markers (header-only for an empty
 * file), but always exits 1, so the "error" is the success path here.
 */
export async function untrackedFileDiff(repoPath: string, path: string): Promise<string> {
  try {
    await git(repoPath, ['diff', '--no-index', '--', '/dev/null', path]);
    return '';
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    if (e.code === 1 && typeof e.stdout === 'string') return e.stdout;
    throw err;
  }
}

/** Diff of uncommitted changes (staged + unstaged + untracked) against HEAD. */
export async function workingTreeDiff(repoPath: string): Promise<string> {
  const tracked = await git(repoPath, ['diff', 'HEAD']);
  const untracked = await untrackedPaths(repoPath);
  const extra = await Promise.all(untracked.map((p) => untrackedFileDiff(repoPath, p)));
  return [tracked, ...extra].filter((d) => d.trim()).join('');
}

export async function resolveSha(repoPath: string, ref: string): Promise<string> {
  return (await git(repoPath, ['rev-parse', ref])).trim();
}

/** Paths changed between base and head (or working tree vs HEAD when head is null). */
export async function changedPaths(repoPath: string, baseRef: string, headRef: string | null): Promise<string[]> {
  const args = headRef ? ['diff', '--name-only', `${baseRef}...${headRef}`] : ['diff', '--name-only', 'HEAD'];
  const paths = (await git(repoPath, args)).split('\n').filter(Boolean);
  return headRef ? paths : [...paths, ...(await untrackedPaths(repoPath))];
}
