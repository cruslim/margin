import { describe, expect, it } from 'vitest';
import { parseCommitLog } from './gitService.js';

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
