import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { hasGeneratedMarker, isGeneratedPath } from '../shared/generated.js';
import type { ChangedFile, FileDiff, RepoInfo } from '../shared/ipc.js';
import type { ReviewTarget } from '../engine/types.js';
import { untrackedFileDiff, untrackedPaths } from '../engine/worktree.js';

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
  const branches = (await git(path, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads']))
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
  // Working-tree reviews: `git diff` never lists untracked files — surface them as added.
  if (!target.headRef) {
    for (const p of await untrackedPaths(target.repoPath)) files.push({ path: p, status: 'A' });
    files.sort((a, b) => a.path.localeCompare(b.path));
  }
  // After the untracked pass, so a brand-new generated file gets flagged too.
  await markGenerated(target, files);
  return files;
}

/** Files to sniff before giving up and going on path patterns alone. */
const SNIFF_LIMIT = 200;
const SNIFF_CHUNK = 8;
/** Enough to cover any file header; keeps a lockfile out of memory. */
const HEAD_BYTES = 4096;

/**
 * Set `generated` on each file. Path patterns cost nothing; anything they miss
 * needs the head of the new content, which is one read per file — so the sniff
 * is skipped for deleted files and for changesets too large to sniff cheaply.
 */
async function markGenerated(target: ReviewTarget, files: ChangedFile[]): Promise<void> {
  const needSniff: ChangedFile[] = [];
  for (const f of files) {
    if (isGeneratedPath(f.path)) f.generated = true;
    else if (f.status !== 'D' && files.length <= SNIFF_LIMIT) needSniff.push(f);
  }
  for (let i = 0; i < needSniff.length; i += SNIFF_CHUNK) {
    await Promise.all(
      needSniff.slice(i, i + SNIFF_CHUNK).map(async (f) => {
        const content = target.headRef
          ? await showFile(target.repoPath, target.headRef, f.path)
          : await readFile(join(target.repoPath, f.path), 'utf8').catch(() => '');
        if (hasGeneratedMarker(content.slice(0, HEAD_BYTES))) f.generated = true;
      }),
    );
  }
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
 *
 * AI-generated diffs routinely miscount hunk-header totals (--recount, always
 * on) and drift from the real file in their context lines (reflowed prose,
 * whitespace) — so failed applies retry with increasingly lenient matching.
 * Every level still --checks the whole patch first, so nothing half-applies;
 * `note` reports when a lenient level was needed.
 */
export async function applyPatch(
  repoPath: string,
  patch: string,
): Promise<{ ok: boolean; error?: string; note?: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'margin-patch-'));
  const file = join(dir, 'proposed.patch');
  const attempts: { note?: string; flags: string[] }[] = [
    { flags: [] },
    { note: 'ignored whitespace differences', flags: ['--ignore-space-change', '--whitespace=nowarn'] },
    // -C1: anchor each hunk on 1 matching context line per side instead of 3.
    { note: 'matched with reduced context', flags: ['--ignore-space-change', '--whitespace=nowarn', '-C1'] },
  ];
  try {
    await writeFile(file, patch.endsWith('\n') ? patch : patch + '\n');
    let firstError: string | undefined;
    for (const attempt of attempts) {
      try {
        await git(repoPath, ['apply', '--check', '--recount', ...attempt.flags, file]);
        await git(repoPath, ['apply', '--recount', ...attempt.flags, file]);
        return { ok: true, note: attempt.note };
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        // The exact-match error names the first mismatched hunk — most useful.
        firstError ??= (e.stderr || e.message || String(err)).trim();
      }
    }
    return { ok: false, error: firstError };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function fileDiff(target: ReviewTarget, path: string): Promise<FileDiff> {
  const { repoPath, baseRef, headRef } = target;
  let hunkText = await git(repoPath, ['diff', ...diffArgs(target), '--', path]);

  let oldContent: string;
  let newContent: string;
  if (headRef) {
    const mergeBase = (await git(repoPath, ['merge-base', baseRef, headRef])).trim();
    oldContent = await showFile(repoPath, mergeBase, path);
    newContent = await showFile(repoPath, headRef, path);
  } else {
    oldContent = await showFile(repoPath, 'HEAD', path);
    newContent = await readFile(join(repoPath, path), 'utf8').catch(() => '');
    // Untracked file: `git diff` produced nothing — synthesize the new-file hunk.
    if (!hunkText.trim() && !oldContent && newContent) {
      hunkText = await untrackedFileDiff(repoPath, path);
    }
  }

  return {
    path,
    oldContent,
    newContent,
    hunks: hunkText.trim() ? [hunkText] : [],
    lang: LANG_BY_EXT[extname(path)] ?? 'plaintext',
  };
}
