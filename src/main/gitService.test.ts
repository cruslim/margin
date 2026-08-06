import { describe, expect, it } from 'vitest';
import { parseCommitLog, parseNumstat } from './gitService.js';

/** Build the exact shape `git log --format=%h%x1f%s%x1f%an%x1f%aI%x1e` emits. */
const log = (...commits: string[][]) =>
  commits.map((fields) => fields.join('\x1f') + '\x1e').join('\n');

describe('parseCommitLog', () => {
  it('parses one commit per record', () => {
    const out = log(
      ['3204667', 'Merge pull request #12', 'Chris Ruslim', '2026-07-30T11:02:03+10:00'],
      ['57b2b69', 'Specialist subagents for comment threads', 'Chris Ruslim', '2026-07-30T09:40:00+10:00'],
    );
    expect(parseCommitLog(out)).toEqual([
      {
        sha: '3204667',
        subject: 'Merge pull request #12',
        author: 'Chris Ruslim',
        date: '2026-07-30T11:02:03+10:00',
      },
      {
        sha: '57b2b69',
        subject: 'Specialist subagents for comment threads',
        author: 'Chris Ruslim',
        date: '2026-07-30T09:40:00+10:00',
      },
    ]);
  });

  it('keeps subjects containing the characters a newline-delimited format would break on', () => {
    const out = log(['abc1234', 'fix: handle a: b | c — and (parens)', 'A Dev', '2026-07-30T09:00:00Z']);
    expect(parseCommitLog(out)[0].subject).toBe('fix: handle a: b | c — and (parens)');
  });

  it('is empty for no commits', () => {
    expect(parseCommitLog('')).toEqual([]);
    expect(parseCommitLog('\n')).toEqual([]);
  });

  it('ignores a trailing record separator', () => {
    const out = log(['abc1234', 'only commit', 'A Dev', '2026-07-30T09:00:00Z']);
    expect(parseCommitLog(out)).toHaveLength(1);
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
