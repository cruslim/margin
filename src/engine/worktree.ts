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

/** Diff of uncommitted changes (staged + unstaged) against HEAD. */
export async function workingTreeDiff(repoPath: string): Promise<string> {
  return git(repoPath, ['diff', 'HEAD']);
}

export async function resolveSha(repoPath: string, ref: string): Promise<string> {
  return (await git(repoPath, ['rev-parse', ref])).trim();
}
