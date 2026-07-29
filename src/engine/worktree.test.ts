import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changedPaths, untrackedFileDiff, untrackedPaths, workingTreeDiff } from './worktree.js';
import { changedFiles, fileDiff } from '../main/gitService.js';

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
  it('lists untracked files as added, sorted with the rest', async () => {
    expect(await changedFiles(target())).toEqual([
      { path: 'fresh.txt', status: 'A' },
      { path: 'tracked.txt', status: 'M' },
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
