import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  branchCommits,
  changedFiles,
  EMPTY_TREE,
  fileDiff,
  mapLines,
  parseCommitLog,
  parseNumstat,
  parseReverseBlame,
} from './gitService.js';

/** Build the exact shape `git log --format=%h%x1f%H%x1f%P%x1f%s%x1f%an%x1f%aI%x1e` emits. */
const log = (...commits: string[][]) =>
  commits.map((fields) => fields.join('\x1f') + '\x1e').join('\n');

describe('parseCommitLog', () => {
  it('parses one commit per record', () => {
    const out = log(
      ['3204667', '3204667f', 'aaaa bbbb', 'Merge pull request #12', 'Chris Ruslim', '2026-07-30T11:02:03+10:00'],
      ['57b2b69', '57b2b69f', 'cccc', 'Specialist subagents for comment threads', 'Chris Ruslim', '2026-07-30T09:40:00+10:00'],
    );
    expect(parseCommitLog(out)).toEqual([
      {
        sha: '3204667',
        hash: '3204667f',
        // A merge lists both parents; the first is the line it was made on.
        parent: 'aaaa',
        subject: 'Merge pull request #12',
        author: 'Chris Ruslim',
        date: '2026-07-30T11:02:03+10:00',
      },
      {
        sha: '57b2b69',
        hash: '57b2b69f',
        parent: 'cccc',
        subject: 'Specialist subagents for comment threads',
        author: 'Chris Ruslim',
        date: '2026-07-30T09:40:00+10:00',
      },
    ]);
  });

  it('keeps subjects containing the characters a newline-delimited format would break on', () => {
    const out = log(['abc1234', 'abc1234f', 'p', 'fix: handle a: b | c — and (parens)', 'A Dev', '2026-07-30T09:00:00Z']);
    expect(parseCommitLog(out)[0].subject).toBe('fix: handle a: b | c — and (parens)');
  });

  it('is empty for no commits', () => {
    expect(parseCommitLog('')).toEqual([]);
    expect(parseCommitLog('\n')).toEqual([]);
  });

  it('ignores a trailing record separator', () => {
    const out = log(['abc1234', 'abc1234f', 'p', 'only commit', 'A Dev', '2026-07-30T09:00:00Z']);
    expect(parseCommitLog(out)).toHaveLength(1);
  });

  it('gives a root commit an empty parent', () => {
    const out = log(['abc1234', 'abc1234f', '', 'root', 'A Dev', '2026-07-30T09:00:00Z']);
    expect(parseCommitLog(out)[0].parent).toBe('');
  });
});

describe('parseNumstat', () => {
  it('parses added/deleted counts per path', () => {
    const out = '42\t0\tsrc/auth/session.ts\0' + '18\t9\tsrc/auth/middleware.ts\0';
    expect(parseNumstat(out)).toEqual(
      new Map([
        ['src/auth/session.ts', { additions: 42, deletions: 0 }],
        ['src/auth/middleware.ts', { additions: 18, deletions: 9 }],
      ]),
    );
  });

  it('keys a rename record (empty path, then old and new fields) by its new path', () => {
    const out = '3\t1\t\0old/name.ts\0new/name.ts\0' + '5\t0\tother.ts\0';
    const map = parseNumstat(out);
    expect(map.get('new/name.ts')).toEqual({ additions: 3, deletions: 1 });
    expect(map.has('old/name.ts')).toBe(false);
    expect(map.get('other.ts')).toEqual({ additions: 5, deletions: 0 });
  });

  it('skips binary files, including a binary rename, without derailing later records', () => {
    const out = '-\t-\timg/logo.png\0' + '-\t-\t\0a.png\0b.png\0' + '7\t2\tsrc/a.ts\0';
    const map = parseNumstat(out);
    expect(map.has('img/logo.png')).toBe(false);
    expect(map.has('b.png')).toBe(false);
    expect(map.get('src/a.ts')).toEqual({ additions: 7, deletions: 2 });
  });

  it('is empty for no output', () => {
    expect(parseNumstat('')).toEqual(new Map());
  });
});

describe('mapLines', () => {
  it('is the identity with no hunks', () => {
    expect(mapLines('', 3)).toEqual([1, 2, 3]);
  });

  it('shifts lines below an insertion without superseding the line it follows', () => {
    // Two lines inserted after line 1.
    expect(mapLines('@@ -1,0 +2,2 @@\n+x\n+y\n', 3)).toEqual([1, 4, 5]);
  });

  it('handles an insertion at the very top', () => {
    expect(mapLines('@@ -0,0 +1 @@\n+x\n', 2)).toEqual([2, 3]);
  });

  it('supersedes edited and deleted lines and shifts the rest', () => {
    // From a,b,c,d,e to x,a,B,c,e: insert at top, edit b, delete d.
    const diff = '@@ -0,0 +1 @@\n+x\n@@ -2 +3 @@ a\n-b\n+B\n@@ -4 +4,0 @@ c\n-d\n';
    expect(mapLines(diff, 5)).toEqual([2, null, 4, null, 5]);
  });

  it('supersedes a multi-line edit that shrinks', () => {
    expect(mapLines('@@ -2,3 +2 @@\n-b\n-c\n-d\n+z\n', 5)).toEqual([1, null, null, null, 3]);
  });
});

describe('parseReverseBlame', () => {
  it('keys the last-seen commit by the line in the blamed version', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const out = [
      `${a} 2 1 1`,
      'author t',
      'filename f',
      '\tline one',
      `${b} 4 2 1`,
      'filename f',
      '\tline two',
      `${a} 3 3`,
      '\tline three',
    ].join('\n');
    expect(parseReverseBlame(out)).toEqual(
      new Map([
        [1, a],
        [2, b],
        [3, a],
      ]),
    );
  });
});

describe('commit ranges', () => {
  const run = promisify(execFile);
  const git = async (args: string[]) => (await run('git', ['-C', repo, ...args])).stdout.trim();
  let repo: string;
  const commit = async (files: Record<string, string | null>, message: string) => {
    for (const [name, content] of Object.entries(files)) {
      if (content === null) await git(['rm', '-q', name]);
      else {
        await writeFile(join(repo, name), content);
        await git(['add', name]);
      }
    }
    await git(['commit', '-q', '-m', message]);
  };

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'margin-lens-'));
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'test@test']);
    await git(['config', 'user.name', 'test']);
    await commit({ 'base.txt': 'base\n' }, 'base');
    await git(['checkout', '-q', '-b', 'feature']);
    await commit({ 'f.txt': 'a\nb\nc\nd\ne\n', 'gone.txt': 'one\ntwo\n' }, 'c1');
    await commit({ 'f.txt': 'a\nB\nc\nd\ne\n' }, 'c2');
    await commit({ 'f.txt': 'x\na\nB\nc\ne\n', 'gone.txt': null }, 'c3');
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const target = () => ({ repoPath: repo, baseRef: 'main', headRef: 'feature' });
  const commits = async () => {
    const list = await branchCommits(target());
    return Object.fromEntries(list.map((c) => [c.subject, c]));
  };

  it('lists only the files one commit touched', async () => {
    const { c2 } = await commits();
    const files = await changedFiles(target(), { from: c2.parent, to: c2.hash });
    expect(files.map((f) => f.path)).toEqual(['f.txt']);
    expect(files[0]).toMatchObject({ status: 'M', additions: 1, deletions: 1 });
  });

  it('diffs a root commit against the empty tree', async () => {
    const root = await git(['rev-list', '--max-parents=0', 'main']);
    const files = await changedFiles({ ...target(), headRef: 'main' }, { from: EMPTY_TREE, to: root });
    expect(files.map((f) => f.path)).toEqual(['base.txt']);
    const d = await fileDiff({ ...target(), headRef: 'main' }, 'base.txt', { from: EMPTY_TREE, to: root });
    expect(d.oldContent).toBe('');
    expect(d.newContent).toBe('base\n');
  });

  it('maps a commit\'s lines onto the tip and names who superseded the rest', async () => {
    const { c1, c2, c3 } = await commits();
    const d = await fileDiff(target(), 'f.txt', { from: c1.parent, to: c1.hash });
    expect(d.newContent).toBe('a\nb\nc\nd\ne\n');
    expect(d.lens?.tipPath).toBe('f.txt');
    expect(d.lens?.tipContent).toBe('x\na\nB\nc\ne\n');
    expect(d.lens?.tipLine).toEqual([2, null, 4, null, 5]);
    expect(d.lens?.superseded).toEqual([
      { start: 2, end: 2, by: { hash: c2.hash, sha: c2.sha, subject: 'c2' } },
      { start: 4, end: 4, by: { hash: c3.hash, sha: c3.sha, subject: 'c3' } },
    ]);
  });

  it('maps the tip commit onto itself', async () => {
    const { c3 } = await commits();
    const d = await fileDiff(target(), 'f.txt', { from: c3.parent, to: c3.hash });
    expect(d.lens?.tipLine).toEqual([1, 2, 3, 4, 5]);
    expect(d.lens?.superseded).toEqual([]);
  });

  it('supersedes every line of a file deleted later', async () => {
    const { c1, c3 } = await commits();
    const d = await fileDiff(target(), 'gone.txt', { from: c1.parent, to: c1.hash });
    expect(d.lens?.tipPath).toBeNull();
    expect(d.lens?.tipLine).toEqual([null, null]);
    expect(d.lens?.superseded).toEqual([{ start: 1, end: 2, by: { hash: c3.hash, sha: c3.sha, subject: 'c3' } }]);
  });

  it('follows a file renamed after the commit', async () => {
    await git(['checkout', '-q', '-b', 'renamed', 'feature']);
    await git(['mv', 'f.txt', 'g.txt']);
    await git(['commit', '-q', '-m', 'rename']);
    const list = await branchCommits({ ...target(), headRef: 'renamed' });
    const c1 = list.find((c) => c.subject === 'c1')!;
    const d = await fileDiff({ ...target(), headRef: 'renamed' }, 'f.txt', { from: c1.parent, to: c1.hash });
    expect(d.lens?.tipPath).toBe('g.txt');
    expect(d.lens?.tipLine).toEqual([2, null, 4, null, 5]);
    await git(['checkout', '-q', 'feature']);
  });
});
