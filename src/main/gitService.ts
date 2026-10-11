import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { hasGeneratedMarker, isGeneratedPath } from '../shared/generated.js';
import { EMPTY_TREE } from '../shared/ipc.js';
import type { ChangedFile, CommitInfo, CommitRange, FileDiff, LensMap, RefState, RepoInfo } from '../shared/ipc.js';
import type { ReviewTarget } from '../engine/types.js';
import { effectiveBaseSha, resolveBase, untrackedFileDiff, untrackedPaths } from '../engine/worktree.js';

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

/**
 * The commit a branch target is compared against — see resolveBase for why it
 * isn't simply `baseRef`. Null for a working-tree target, which diffs HEAD.
 * Resolved once per public entry point and threaded down: it costs a handful of
 * git calls, so the two diffs behind a file list shouldn't each redo it.
 */
async function baseOf(target: ReviewTarget): Promise<string | null> {
  return target.headRef ? effectiveBaseSha(target.repoPath, target.baseRef, target.headRef) : null;
}

// `git show <empty tree>:path` fails, which showFile already reads as "file didn't exist".
export { EMPTY_TREE };

/**
 * The two sides of a diff. A commit range wins outright — it's a slice of the
 * branch, so the base doesn't come into it.
 */
function diffArgs(target: ReviewTarget, baseSha: string | null, range?: CommitRange): string[] {
  if (range) return [range.from, range.to];
  return baseSha && target.headRef ? [baseSha, target.headRef] : ['HEAD'];
}

/** The base, unless a range makes it irrelevant — no point paying for resolveBase then. */
async function baseFor(target: ReviewTarget, range?: CommitRange): Promise<string | null> {
  return range ? null : baseOf(target);
}

export async function changedFiles(target: ReviewTarget, range?: CommitRange): Promise<ChangedFile[]> {
  const baseSha = await baseFor(target, range);
  const out = await git(target.repoPath, ['diff', '--name-status', '-z', ...diffArgs(target, baseSha, range)]);
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
  if (!target.headRef && !range) {
    untracked = new Set(await untrackedPaths(target.repoPath));
    for (const p of untracked) files.push({ path: p, status: 'A' });
    files.sort((a, b) => a.path.localeCompare(b.path));
  }
  await addLineCounts(target, diffArgs(target, baseSha, range), files, untracked);
  // After the untracked pass, so a brand-new generated file gets flagged too.
  await markGenerated(target.repoPath, range?.to ?? target.headRef, files);
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
async function addLineCounts(
  target: ReviewTarget,
  sides: string[],
  files: ChangedFile[],
  untracked: Set<string>,
): Promise<void> {
  const stats = parseNumstat(await git(target.repoPath, ['diff', '--numstat', '-z', ...sides]));
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
const COMMIT_FORMAT = '%h%x1f%H%x1f%P%x1f%s%x1f%an%x1f%aI%x1e';

/** Parse `git log --format=COMMIT_FORMAT` output. Exported for tests. */
export function parseCommitLog(out: string): CommitInfo[] {
  return out
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim())
    .map((record) => {
      const [sha, hash, parents, subject, author, date] = record.split('\x1f');
      // %P lists every parent; the first is the line the commit was made on.
      return { sha, hash, parent: parents.split(' ')[0] ?? '', subject, author, date };
    });
}

/**
 * Commits on the branch that aren't in its base — the branch's own work.
 * Working-tree targets have none by definition: the changes under review are
 * uncommitted.
 *
 * Logged from the effective base rather than `baseRef` so a branch rebased onto
 * a moved upstream doesn't list the upstream's commits as its own, and so the
 * list agrees with the diff beside it. --topo-order keeps the chain in graph
 * order: a rebase rewrites committer dates but preserves author dates, which is
 * what each row shows, so date order and history order can disagree.
 */
export async function branchCommits(target: ReviewTarget): Promise<CommitInfo[]> {
  if (!target.headRef) return [];
  try {
    const baseSha = await effectiveBaseSha(target.repoPath, target.baseRef, target.headRef);
    const out = await git(target.repoPath, [
      'log',
      `${baseSha}..${target.headRef}`,
      '--topo-order',
      `--max-count=${MAX_COMMITS}`,
      `--format=${COMMIT_FORMAT}`,
    ]);
    return parseCommitLog(out);
  } catch {
    return []; // unknown ref (branch deleted or renamed) — not worth failing the view
  }
}

/**
 * Where a branch target's refs currently stand. The renderer compares this on
 * window focus to notice commits, amends and rebases made outside the app —
 * cheap enough to run on every focus, unlike re-reading the changeset.
 *
 * Null for a working-tree target: uncommitted edits move no ref, so there is
 * nothing here that would reveal them.
 */
export async function refState(target: ReviewTarget): Promise<RefState | null> {
  if (!target.headRef) return null;
  try {
    const headSha = (await git(target.repoPath, ['rev-parse', target.headRef])).trim();
    const base = await resolveBase(target.repoPath, target.baseRef, target.headRef);
    return { headSha, baseSha: base.sha, baseVia: base.via, mergedInto: base.mergedInto };
  } catch {
    return null; // unknown ref (branch deleted or renamed) — same stance as branchCommits
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
async function markGenerated(repoPath: string, ref: string | null, files: ChangedFile[]): Promise<void> {
  const needSniff: ChangedFile[] = [];
  for (const f of files) {
    if (isGeneratedPath(f.path)) f.generated = true;
    else if (f.status !== 'D' && files.length <= SNIFF_LIMIT) needSniff.push(f);
  }
  for (let i = 0; i < needSniff.length; i += SNIFF_CHUNK) {
    await Promise.all(
      needSniff.slice(i, i + SNIFF_CHUNK).map(async (f) => {
        const content = ref
          ? await showFile(repoPath, ref, f.path)
          : await readFile(join(repoPath, f.path), 'utf8').catch(() => '');
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

export async function fileDiff(target: ReviewTarget, path: string, range?: CommitRange): Promise<FileDiff> {
  const { repoPath, headRef } = target;
  const baseSha = await baseFor(target, range);
  let hunkText = await git(repoPath, ['diff', ...diffArgs(target, baseSha, range), '--', path]);

  let oldContent: string;
  let newContent: string;
  let lens: LensMap | undefined;
  if (range) {
    oldContent = await showFile(repoPath, range.from, path);
    newContent = await showFile(repoPath, range.to, path);
    // A range only exists for branch targets — there's a tip to map onto.
    if (headRef) lens = await lensMap(repoPath, range.to, headRef, path, newContent);
  } else if (headRef && baseSha) {
    oldContent = await showFile(repoPath, baseSha, path);
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
    ...(lens ? { lens } : {}),
  };
}

/** Lines in `content`, counted the way the diff viewer numbers them. */
function lineCount(content: string): number {
  if (!content) return 0;
  return content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length;
}

/**
 * Map each line of a file at one commit onto the same file at a later one,
 * from the old-side ranges of a `git diff -U0` between them. A line inside a
 * changed range is superseded (null); every other line shifts by what the
 * hunks above it added and removed. Exported for tests.
 */
export function mapLines(diffText: string, count: number): (number | null)[] {
  const map: (number | null)[] = [];
  let offset = 0;
  let next = 1; // next commit-side line to place
  for (const m of diffText.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldStart = Number(m[1]);
    const oldLen = m[2] === undefined ? 1 : Number(m[2]);
    const newLen = m[4] === undefined ? 1 : Number(m[4]);
    // A pure insertion's old start is the line it follows, not one it touches.
    const firstTouched = oldLen === 0 ? oldStart + 1 : oldStart;
    for (; next < firstTouched && next <= count; next++) map.push(next + offset);
    for (let k = 0; k < oldLen && next <= count; k++, next++) map.push(null);
    offset += newLen - oldLen;
  }
  for (; next <= count; next++) map.push(next + offset);
  return map;
}

/**
 * Parse `git blame --reverse --porcelain` into the last commit each line was
 * seen in, by commit-side line. A header line is `<sha> <line there> <line
 * here> [<group size>]`; the content and metadata lines in between never start
 * with 40 hex characters and a space. Exported for tests.
 */
export function parseReverseBlame(out: string): Map<number, string> {
  const lastSeen = new Map<number, string>();
  for (const m of out.matchAll(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/gm)) lastSeen.set(Number(m[2]), m[1]);
  return lastSeen;
}

/**
 * Where `path` at `from` lives at `to`: itself, a rename target, or null once
 * deleted. Rename detection needs the whole tree in view, so this is a
 * separate (cheap, name-only) diff from the content one.
 */
async function pathAt(repoPath: string, from: string, to: string, path: string): Promise<string | null> {
  const parts = (await git(repoPath, ['diff', '-M', '--name-status', '-z', from, to])).split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; ) {
    const status = parts[i][0];
    if (status === 'R' || status === 'C') {
      if (status === 'R' && parts[i + 1] === path) return parts[i + 2];
      i += 3;
    } else {
      if (status === 'D' && parts[i + 1] === path) return null;
      i += 2;
    }
  }
  return path;
}

/**
 * Line up a file at commit `at` with the branch tip — see LensMap. The mapping
 * comes from the diff alone; blame only names who superseded each run, so a
 * blame failure costs the "changed in" label, never the mapping.
 */
async function lensMap(repoPath: string, at: string, headRef: string, path: string, content: string): Promise<LensMap> {
  const tip = (await git(repoPath, ['rev-parse', headRef])).trim();
  const count = lineCount(content);
  const tipPath = await pathAt(repoPath, at, tip, path);
  if (tipPath === null) {
    return {
      tipPath,
      tipContent: '',
      tipLine: Array(count).fill(null),
      superseded: count ? [{ start: 1, end: count, by: await firstCommitAfter(repoPath, at, tip, path) }] : [],
    };
  }
  const [diffText, tipContent] = await Promise.all([
    git(repoPath, ['diff', '-M', '-U0', '--no-color', at, tip, '--', path, tipPath]),
    showFile(repoPath, tip, tipPath),
  ]);
  const tipLine = mapLines(diffText, count);

  const runs: { start: number; end: number }[] = [];
  tipLine.forEach((t, i) => {
    if (t !== null) return;
    const last = runs[runs.length - 1];
    if (last && last.end === i) last.end = i + 1;
    else runs.push({ start: i + 1, end: i + 1 });
  });
  if (runs.length === 0) return { tipPath, tipContent, tipLine, superseded: [] };

  let lastSeen = new Map<number, string>();
  try {
    lastSeen = parseReverseBlame(await git(repoPath, ['blame', '--reverse', '--porcelain', `${at}..${tip}`, '--', path]));
  } catch {
    // blame can refuse (e.g. a path it can't follow) — runs just go unlabelled.
  }
  const children = new Map<string, Promise<LensMap['superseded'][number]['by']>>();
  const superseded = await Promise.all(
    runs.map(async (r) => {
      // The run's first line stands for it: a run is usually one edit.
      const seen = lastSeen.get(r.start);
      if (!seen || seen === tip) return { ...r, by: null };
      if (!children.has(seen)) children.set(seen, childOf(repoPath, seen, tip));
      return { ...r, by: await children.get(seen)! };
    }),
  );
  return { tipPath, tipContent, tipLine, superseded };
}

/** The commit after `sha` on its way to `tip` — the one that changed a line `sha` was the last to have. */
async function childOf(repoPath: string, sha: string, tip: string): Promise<LensMap['superseded'][number]['by']> {
  try {
    const out = await git(repoPath, ['log', '--ancestry-path', '--reverse', '--format=%H%x1f%h%x1f%s', `${sha}..${tip}`]);
    const first = out.split('\n')[0];
    if (!first) return null;
    const [hash, short, subject] = first.split('\x1f');
    return { hash, sha: short, subject };
  } catch {
    return null;
  }
}

/** The first commit after `at` that touched `path` — who deleted (or renamed away) a file. */
async function firstCommitAfter(
  repoPath: string,
  at: string,
  tip: string,
  path: string,
): Promise<LensMap['superseded'][number]['by']> {
  try {
    const out = await git(repoPath, ['log', '--reverse', '--format=%H%x1f%h%x1f%s', `${at}..${tip}`, '--', path]);
    const first = out.split('\n')[0];
    if (!first) return null;
    const [hash, short, subject] = first.split('\x1f');
    return { hash, sha: short, subject };
  } catch {
    return null;
  }
}
