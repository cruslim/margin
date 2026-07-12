import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type { ChangedFile, FileDiff, RepoInfo } from '../shared/ipc.js';
import type { ReviewTarget } from '../engine/types.js';

const run = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export async function openRepo(path: string): Promise<RepoInfo | null> {
  try {
    await git(path, ['rev-parse', '--git-dir']);
  } catch {
    return null;
  }
  const branches = (await git(path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))
    .split('\n')
    .filter(Boolean);
  const currentBranch = (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  return { path, name: basename(path), branches, currentBranch };
}

function diffArgs(target: ReviewTarget): string[] {
  return target.headRef ? [`${target.baseRef}...${target.headRef}`] : ['HEAD'];
}

export async function changedFiles(target: ReviewTarget): Promise<ChangedFile[]> {
  const out = await git(target.repoPath, ['diff', '--name-status', '-z', ...diffArgs(target)]);
  const parts = out.split('\0').filter(Boolean);
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i][0] as ChangedFile['status'];
    if (status === 'R') {
      files.push({ path: parts[i + 2], oldPath: parts[i + 1], status });
      i += 3;
    } else {
      files.push({ path: parts[i + 1], status });
      i += 2;
    }
  }
  return files;
}

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.php': 'php', '.css': 'css', '.scss': 'scss', '.html': 'html', '.json': 'json',
  '.yml': 'yaml', '.yaml': 'yaml', '.md': 'markdown', '.sh': 'bash', '.sql': 'sql',
};

async function showFile(repoPath: string, ref: string, path: string): Promise<string> {
  try {
    return await git(repoPath, ['show', `${ref}:${path}`]);
  } catch {
    return ''; // file doesn't exist at that ref (added/deleted)
  }
}

/**
 * Apply an AI-proposed patch to the user's working copy. `--check` first so a
 * patch that doesn't fit the current working tree fails cleanly with git's
 * explanation instead of half-applying.
 */
export async function applyPatch(repoPath: string, patch: string): Promise<{ ok: boolean; error?: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'margin-patch-'));
  const file = join(dir, 'proposed.patch');
  try {
    await writeFile(file, patch.endsWith('\n') ? patch : patch + '\n');
    // --recount: AI-generated diffs routinely miscount hunk-header line totals;
    // let git recount from the hunk body instead of rejecting the patch.
    await git(repoPath, ['apply', '--check', '--recount', file]);
    await git(repoPath, ['apply', '--recount', file]);
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, error: (e.stderr || e.message || String(err)).trim() };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function fileDiff(target: ReviewTarget, path: string): Promise<FileDiff> {
  const { repoPath, baseRef, headRef } = target;
  const hunkText = await git(repoPath, ['diff', ...diffArgs(target), '--', path]);

  let oldContent: string;
  let newContent: string;
  if (headRef) {
    const mergeBase = (await git(repoPath, ['merge-base', baseRef, headRef])).trim();
    oldContent = await showFile(repoPath, mergeBase, path);
    newContent = await showFile(repoPath, headRef, path);
  } else {
    oldContent = await showFile(repoPath, 'HEAD', path);
    newContent = await readFile(join(repoPath, path), 'utf8').catch(() => '');
  }

  return {
    path,
    oldContent,
    newContent,
    hunks: hunkText.trim() ? [hunkText] : [],
    lang: LANG_BY_EXT[extname(path)] ?? 'plaintext',
  };
}
