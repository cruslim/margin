import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { hasGeneratedMarker, isGeneratedPath } from '../shared/generated.js';
import type { ChangedFile, CommitInfo, FileDiff, RepoInfo } from '../shared/ipc.js';
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
  let untracked = new Set<string>();
  if (!target.headRef) {
    untracked = new Set(await untrackedPaths(target.repoPath));
    for (const p of untracked) files.push({ path: p, status: 'A' });
    files.sort((a, b) => a.path.localeCompare(b.path));
  }
  await addLineCounts(target, files, untracked);
  // After the untracked pass, so a brand-new generated file gets flagged too.
  await markGenerated(target, files);
  return files;
}

/**
 * Parse `git diff --numstat -z` output into per-path line counts. A rename
 * record has an empty path field followed by the old and new paths as their
 * own NUL-terminated fields; binary files report `-` counts and are skipped.
 * Exported for tests.
 */
export function parseNumstat(out: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!m) continue;
    let path = m[3];
    if (path === '') {
      path = parts[i + 2]; // rename: next fields are old path, new path
      i += 2;
    }
    if (m[1] !== '-') map.set(path, { additions: Number(m[1]), deletions: Number(m[2]) });
  }
  return map;
}

/**
 * Line counts for an untracked file, invisible to a plain `git diff`. As in
 * untrackedFileDiff, `--no-index` exits 1 whenever it emits a record (even a
 * 0/0 one for an empty file), so the catch is the success path.
 */
async function untrackedNumstat(repoPath: string, path: string): Promise<{ additions: number; deletions: number } | undefined> {
  try {
    await git(repoPath, ['diff', '--no-index', '--numstat', '--', '/dev/null', path]);
    return undefined;
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    if (e.code !== 1 || typeof e.stdout !== 'string') return undefined;
    const m = e.stdout.match(/^(\d+|-)\t(\d+|-)\t/);
    return m && m[1] !== '-' ? { additions: Number(m[1]), deletions: Number(m[2]) } : undefined;
  }
}

/** Fill in additions/deletions on each file; binary files stay uncounted. */
async function addLineCounts(target: ReviewTarget, files: ChangedFile[], untracked: Set<string>): Promise<void> {
  const stats = parseNumstat(await git(target.repoPath, ['diff', '--numstat', '-z', ...diffArgs(target)]));
  for (const f of files) {
    const s = stats.get(f.path);
    if (s) Object.assign(f, s);
  }
  // Untracked files need one git call each — same chunking stance as the sniff below.
  const missing = files.filter((f) => untracked.has(f.path));
  for (let i = 0; i < missing.length; i += SNIFF_CHUNK) {
    await Promise.all(
      missing.slice(i, i + SNIFF_CHUNK).map(async (f) => {
        const s = await untrackedNumstat(target.repoPath, f.path);
        if (s) Object.assign(f, s);
      }),
    );
  }
}

/**
 * Cap on commits listed for a branch. A long-lived branch against an old base
 * can have hundreds; the list is for orientation, not history spelunking.
 */
const MAX_COMMITS = 200;
// Unit separator between fields, record separator between commits — neither can
// appear in a commit subject, unlike newlines.
const COMMIT_FORMAT = '%h%x1f%s%x1f%an%x1f%aI%x1e';

/** Parse `git log --format=COMMIT_FORMAT` output. Exported for tests. */
export function parseCommitLog(out: string): CommitInfo[] {
  return out
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim())
    .map((record) => {
      const [sha, subject, author, date] = record.split('\x1f');
      return { sha, subject, author, date };
    });
}

/**
 * Commits on the branch that aren't in its base (two-dot: the branch's own
 * work). Working-tree targets have none by definition — the changes under
 * review are uncommitted.
 */
export async function branchCommits(target: ReviewTarget): Promise<CommitInfo[]> {
  if (!target.headRef) return [];
  try {
    const out = await git(target.repoPath, [
      'log',
      `${target.baseRef}..${target.headRef}`,
      `--max-count=${MAX_COMMITS}`,
      `--format=${COMMIT_FORMAT}`,
    ]);
    return parseCommitLog(out);
  } catch {
    return []; // unknown ref (branch deleted or renamed) — not worth failing the view
  }
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
