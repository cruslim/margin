import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  branchDiff,
  changedPaths,
  createWorktree,
  removeWorktree,
  resolveBase,
  resolveSha,
  syncWorktree,
  untrackedFileDiff,
  untrackedPaths,
  usableSinceSha,
  workingTreeDiff,
} from './worktree.js';
import { applyPatch, branchCommits, changedFiles, fileDiff } from '../main/gitService.js';

const run = promisify(execFile);
const git = (repo: string, args: string[]) => run('git', ['-C', repo, ...args]);

/** Scratch repo: one committed file, one modified, one untracked, one ignored. */
let repo: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'margin-test-'));
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.email', 'test@test']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'tracked.txt'), 'one\ntwo\n');
  await writeFile(join(repo, 'patch.txt'), 'alpha\nbeta\ngamma  three\ndelta\n');
  await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  await writeFile(join(repo, 'tracked.txt'), 'one\nTWO\n');
  await writeFile(join(repo, 'fresh.txt'), 'hello\nworld\n');
  await writeFile(join(repo, 'ignored.txt'), 'should not appear\n');
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

const target = () => ({ repoPath: repo, baseRef: 'HEAD', headRef: null });

describe('untrackedPaths', () => {
  it('lists untracked files but not tracked or ignored ones', async () => {
    expect(await untrackedPaths(repo)).toEqual(['fresh.txt']);
  });
});

describe('untrackedFileDiff', () => {
  it('renders a new-file hunk with the file content', async () => {
    const diff = await untrackedFileDiff(repo, 'fresh.txt');
    expect(diff).toContain('+++ b/fresh.txt');
    expect(diff).toContain('+hello');
    expect(diff).toContain('+world');
  });

  it('renders a header-only diff for an empty file', async () => {
    await writeFile(join(repo, 'empty.txt'), '');
    try {
      const diff = await untrackedFileDiff(repo, 'empty.txt');
      expect(diff).toContain('new file mode');
      expect(diff).not.toContain('@@');
    } finally {
      await rm(join(repo, 'empty.txt'));
    }
  });
});

describe('workingTreeDiff', () => {
  it('includes tracked modifications and untracked files', async () => {
    const diff = await workingTreeDiff(repo);
    expect(diff).toContain('+TWO');
    expect(diff).toContain('+++ b/fresh.txt');
    expect(diff).not.toContain('ignored.txt');
  });
});

describe('changedPaths (working tree)', () => {
  it('includes untracked files', async () => {
    expect(await changedPaths(repo, 'HEAD', null)).toEqual(['tracked.txt', 'fresh.txt']);
  });
});

describe('changedFiles (working tree)', () => {
  it('lists untracked files as added, sorted with the rest, with line counts', async () => {
    expect(await changedFiles(target())).toEqual([
      { path: 'fresh.txt', status: 'A', additions: 2, deletions: 0 },
      { path: 'tracked.txt', status: 'M', additions: 1, deletions: 1 },
    ]);
  });
});

describe('fileDiff (working tree)', () => {
  it('synthesizes hunks for an untracked file', async () => {
    const d = await fileDiff(target(), 'fresh.txt');
    expect(d.oldContent).toBe('');
    expect(d.newContent).toBe('hello\nworld\n');
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]).toContain('+hello');
  });

  it('still diffs tracked files normally', async () => {
    const d = await fileDiff(target(), 'tracked.txt');
    expect(d.hunks[0]).toContain('+TWO');
    expect(d.hunks[0]).toContain('-two');
  });
});

// Runs last: these tests mutate patch.txt in the scratch repo.
describe('applyPatch retry ladder', () => {
  const hunk = (body: string) =>
    `diff --git a/patch.txt b/patch.txt\n--- a/patch.txt\n+++ b/patch.txt\n@@ -1,4 +1,4 @@\n${body}`;

  it('applies an exact patch with no note', async () => {
    const res = await applyPatch(repo, hunk(' alpha\n-beta\n+BETA\n gamma  three\n delta\n'));
    expect(res).toEqual({ ok: true, note: undefined });
    expect(await readFile(join(repo, 'patch.txt'), 'utf8')).toBe('alpha\nBETA\ngamma  three\ndelta\n');
  });

  it('falls back when context lines have whitespace drift', async () => {
    // Context says "gamma three", file has "gamma  three" — git only forgives
    // differing runs of internal whitespace, so this is the representative case.
    const res = await applyPatch(repo, hunk(' alpha\n-BETA\n+beta2\n gamma three\n delta\n'));
    expect(res.ok).toBe(true);
    expect(res.note).toBe('ignored whitespace differences');
    expect(await readFile(join(repo, 'patch.txt'), 'utf8')).toBe('alpha\nbeta2\ngamma  three\ndelta\n');
  });

  it('falls back to reduced context when an outer context line is wrong', async () => {
    // Second context line below the change is fabricated; -C1 only needs the first.
    const res = await applyPatch(repo, hunk(' alpha\n-beta2\n+beta3\n gamma  three\n FABRICATED\n'));
    expect(res.ok).toBe(true);
    expect(res.note).toBe('matched with reduced context');
    expect(await readFile(join(repo, 'patch.txt'), 'utf8')).toBe('alpha\nbeta3\ngamma  three\ndelta\n');
  });

  it('fails with the exact-match error when nothing fits', async () => {
    const before = await readFile(join(repo, 'patch.txt'), 'utf8');
    const res = await applyPatch(repo, hunk(' nothing\n-here\n+matches\n at\n all\n'));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/patch does not apply|patch failed/);
    expect(await readFile(join(repo, 'patch.txt'), 'utf8')).toBe(before);
  });
});

/**
 * A rebased branch, in the shape that actually breaks: `origin/master` has moved
 * on, the branch was rebased onto it, and the *local* `master` — which the review
 * session names as its base — is still sitting where it was. The upstream commits
 * the rebase pulled in are then on the branch but not in the stale base, so a
 * plain `master..branch` claims them as the branch's own work.
 */
describe('rebased branch with a stale base ref', () => {
  let remote: string;
  let clone: string;
  /** Branch tip before the rebase — the sha a previous review would have recorded. */
  let preRebaseSha: string;

  const init = async (dir: string) => {
    await git(dir, ['config', 'user.email', 'test@test']);
    await git(dir, ['config', 'user.name', 'test']);
  };
  const commit = async (dir: string, name: string, message: string) => {
    await writeFile(join(dir, name), `${name}\n`);
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-q', '-m', message]);
  };

  beforeAll(async () => {
    remote = await mkdtemp(join(tmpdir(), 'margin-remote-'));
    await git(remote, ['init', '-q', '-b', 'master']);
    await init(remote);
    await commit(remote, 'base.txt', 'base');

    clone = await mkdtemp(join(tmpdir(), 'margin-clone-'));
    await rm(clone, { recursive: true, force: true });
    await run('git', ['clone', '-q', remote, clone]);
    await init(clone);
    await git(clone, ['checkout', '-q', '-b', 'feature']);
    await commit(clone, 'mine1.txt', 'mine: one');
    await commit(clone, 'mine2.txt', 'mine: two');
    preRebaseSha = await resolveSha(clone, 'feature');

    // Upstream moves; the clone fetches but never updates its local master.
    await commit(remote, 'theirs1.txt', 'theirs: one');
    await commit(remote, 'theirs2.txt', 'theirs: two');
    await git(clone, ['fetch', '-q', 'origin']);
    await git(clone, ['rebase', '-q', 'origin/master', 'feature']);
  });

  afterAll(async () => {
    await rm(remote, { recursive: true, force: true });
    await rm(clone, { recursive: true, force: true });
  });

  const target = () => ({ repoPath: clone, baseRef: 'master', headRef: 'feature' });

  it('resolves the base to the upstream tip, naming the ref it advanced to', async () => {
    const res = await resolveBase(clone, 'master', 'feature');
    expect(res.sha).toBe(await resolveSha(clone, 'origin/master'));
    // Same branch further on, not a landing — so the label counts commits.
    expect(res.via).toEqual({ ref: 'origin/master', behind: 2, landed: false });
  });

  it('lists only the branch’s own commits', async () => {
    const commits = await branchCommits(target());
    expect(commits.map((c) => c.subject)).toEqual(['mine: two', 'mine: one']);
  });

  it('diffs only the branch’s own files', async () => {
    expect(await changedPaths(clone, 'master', 'feature')).toEqual(['mine1.txt', 'mine2.txt']);
    expect((await changedFiles(target())).map((f) => f.path)).toEqual(['mine1.txt', 'mine2.txt']);
    const diff = await branchDiff(clone, 'master', 'feature');
    expect(diff).toContain('mine1.txt');
    expect(diff).not.toContain('theirs1.txt');
  });

  it('shows a file against the upstream base, not the old branch point', async () => {
    const d = await fileDiff(target(), 'mine1.txt');
    expect(d.oldContent).toBe('');
    expect(d.newContent).toBe('mine1.txt\n');
  });

  it('leaves a branch that was never rebased untouched', async () => {
    // Branched off the same stale master, so it holds none of the upstream work
    // and both candidate bases are the same commit — nothing to advance to.
    await git(clone, ['checkout', '-q', '-b', 'untouched', 'master']);
    await commit(clone, 'solo.txt', 'solo: work');
    const res = await resolveBase(clone, 'master', 'untouched');
    expect(res.sha).toBe(await resolveSha(clone, 'master'));
    expect(res.via).toBeUndefined();
    expect(await changedPaths(clone, 'master', 'untouched')).toEqual(['solo.txt']);
    await git(clone, ['checkout', '-q', 'feature']);
  });

  it('drops a sinceSha the rebase orphaned, and keeps one still on the branch', async () => {
    expect(await usableSinceSha(clone, preRebaseSha, 'feature')).toBeUndefined();
    const onBranch = await resolveSha(clone, 'feature~1');
    expect(await usableSinceSha(clone, onBranch, 'feature')).toBe(onBranch);
    expect(await usableSinceSha(clone, undefined, 'feature')).toBeUndefined();
  });

  it('moves a stale worktree onto the branch tip', async () => {
    const dir = await createWorktree(clone, preRebaseSha);
    try {
      expect(await syncWorktree(clone, dir, 'feature')).toBe(true);
      expect((await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(await resolveSha(clone, 'feature'));
      // Already there: nothing to do, and it says so.
      expect(await syncWorktree(clone, dir, 'feature')).toBe(false);
    } finally {
      await removeWorktree(clone, dir);
    }
  });

  // Last in this block: it moves origin/master, and restores it so the ordering
  // of the tests above can't come to depend on that.
  it('keeps a branch that has already landed upstream reviewable', async () => {
    const fetched = await resolveSha(clone, 'origin/master');
    // The branch has been merged and pushed: origin/master now holds all of it.
    await git(clone, ['update-ref', 'refs/remotes/origin/master', await resolveSha(clone, 'feature')]);
    try {
      // Advancing the base here would put it *on* the branch tip and leave an
      // empty changeset, so it stays on the base ref and reports why.
      const res = await resolveBase(clone, 'master', 'feature');
      expect(res.sha).toBe(await resolveSha(clone, 'master'));
      expect(res.via).toBeUndefined();
      expect(res.mergedInto).toBe('origin/master');
      expect((await branchCommits(target())).map((c) => c.subject)).toContain('mine: two');
      expect(await changedPaths(clone, 'master', 'feature')).toContain('mine1.txt');
    } finally {
      await git(clone, ['update-ref', 'refs/remotes/origin/master', fetched]);
    }
  });
});

/**
 * A stack whose lower branch has landed. `parent` was merged into the mainline
 * (its remote branch deleted with the PR, so it has no upstream left to consult),
 * the mainline has moved on since, and `child` has been rebased onto it. The
 * merge-base with `parent` is where it stood *then*, so comparing against it
 * claims the whole mainline since as the child's own work.
 */
describe('branch rebased past a base that has landed in the mainline', () => {
  let remote: string;
  let clone: string;
  /** The commit both the mainline and the stack grew from. */
  let root: string;

  const commit = async (dir: string, name: string, message: string) => {
    await writeFile(join(dir, name), `${name}\n`);
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-q', '-m', message]);
  };
  const configure = async (dir: string) => {
    await git(dir, ['config', 'user.email', 'test@test']);
    await git(dir, ['config', 'user.name', 'test']);
  };

  beforeAll(async () => {
    // Seed → bare → working clone, so the clone records origin/HEAD the way a
    // real one does; that ref is how the mainline is found.
    const seed = await mkdtemp(join(tmpdir(), 'margin-seed-'));
    await git(seed, ['init', '-q', '-b', 'master']);
    await configure(seed);
    await commit(seed, 'base.txt', 'base');
    remote = await mkdtemp(join(tmpdir(), 'margin-bare-'));
    await rm(remote, { recursive: true, force: true });
    await run('git', ['clone', '-q', '--bare', seed, remote]);
    clone = await mkdtemp(join(tmpdir(), 'margin-stack-'));
    await rm(clone, { recursive: true, force: true });
    await run('git', ['clone', '-q', remote, clone]);
    await configure(clone);
    await rm(seed, { recursive: true, force: true });
    root = await resolveSha(clone, 'master');

    await git(clone, ['checkout', '-q', '-b', 'parent']);
    await commit(clone, 'p1.txt', 'p1');
    await git(clone, ['checkout', '-q', '-b', 'child']);
    await commit(clone, 'c1.txt', 'c1');

    // parent lands in the mainline, which then gains two more commits.
    await git(clone, ['checkout', '-q', '-b', 'landing', 'parent']);
    await commit(clone, 'u1.txt', 'u1');
    await commit(clone, 'u2.txt', 'u2');
    await git(clone, ['push', '-q', 'origin', 'landing:master']);
    await git(clone, ['checkout', '-q', 'child']);
    await git(clone, ['branch', '-D', 'landing']);
    await git(clone, ['fetch', '-q', 'origin']);
    await git(clone, ['rebase', '-q', 'origin/master', 'child']);

    // A healthy stack on top of the rebased child.
    await git(clone, ['checkout', '-q', '-b', 'grandchild', 'child']);
    await commit(clone, 'g1.txt', 'g1');
  });

  afterAll(async () => {
    await rm(remote, { recursive: true, force: true });
    await rm(clone, { recursive: true, force: true });
  });

  it('advances to the mainline the landed base is now part of', async () => {
    // Local master is still at the root here, so it doesn't contain the base and
    // the remote mainline is the only candidate left.
    const res = await resolveBase(clone, 'parent', 'child');
    expect(res.sha).toBe(await resolveSha(clone, 'origin/master'));
    expect(res.via).toEqual({ ref: 'origin/master', behind: 2, landed: true });
    const commits = await branchCommits({ repoPath: clone, baseRef: 'parent', headRef: 'child' });
    expect(commits.map((c) => c.subject)).toEqual(['c1']);
    expect(await changedPaths(clone, 'parent', 'child')).toEqual(['c1.txt']);
  });

  it('names the local mainline when the rebase used that', async () => {
    // Rebasing onto a local `master` that is level with the remote should be
    // described as `master`: both reach the same commit, and that is the ref the
    // rebase named. Same sha either way, so only the label is at stake.
    const before = await resolveSha(clone, 'master');
    await git(clone, ['branch', '-f', 'master', 'origin/master']);
    try {
      const res = await resolveBase(clone, 'parent', 'child');
      expect(res.sha).toBe(await resolveSha(clone, 'origin/master'));
      expect(res.via).toEqual({ ref: 'master', behind: 2, landed: true });
    } finally {
      await git(clone, ['branch', '-f', 'master', before]);
    }
  });

  it('keeps a stack whose base sits above the mainline', async () => {
    // `child` holds a commit the mainline doesn't, so it isn't contained in the
    // mainline and stays the base — the stack is intact and must not be flattened.
    const res = await resolveBase(clone, 'child', 'grandchild');
    expect(res.sha).toBe(await resolveSha(clone, 'child'));
    expect(res.via).toBeUndefined();
    const commits = await branchCommits({ repoPath: clone, baseRef: 'child', headRef: 'grandchild' });
    expect(commits.map((c) => c.subject)).toEqual(['g1']);
  });

  it('leaves a deliberately old base alone when it never landed', async () => {
    // Asking for a comparison against an unmerged side branch means exactly that,
    // however far behind the mainline it is.
    await git(clone, ['checkout', '-q', '-b', 'release', root]);
    await commit(clone, 'r1.txt', 'r1');
    await git(clone, ['checkout', '-q', 'child']);
    const res = await resolveBase(clone, 'release', 'child');
    expect(res.sha).toBe(root);
    expect(res.via).toBeUndefined();
    expect(res.mergedInto).toBeUndefined();
    const commits = await branchCommits({ repoPath: clone, baseRef: 'release', headRef: 'child' });
    expect(commits.map((c) => c.subject)).toEqual(['c1', 'u2', 'u1', 'p1']);
  });
});
