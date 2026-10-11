import { describe, expect, it } from 'vitest';
import type { CommitInfo } from '../../../shared/ipc.js';
import { stepTarget } from './CommitStepper.js';

const commit = (hash: string, parent: string): CommitInfo => ({
  sha: hash.slice(0, 3),
  hash,
  parent,
  subject: `subject ${hash}`,
  author: 'a',
  date: '2026-10-01T00:00:00Z',
});
// Newest first, as branchCommits lists them: c3 → c2 → c1 → (base).
const commits = [commit('c3', 'c2'), commit('c2', 'c1'), commit('c1', 'base')];

describe('stepTarget', () => {
  it('starts a walkthrough at the first commit, or the latest going back', () => {
    expect(stepTarget(commits, null, 'newer')).toEqual({ anchor: 'c1', end: 'c1' });
    expect(stepTarget(commits, null, 'older')).toEqual({ anchor: 'c3', end: 'c3' });
  });

  it('steps one commit at a time and stops at the ends', () => {
    expect(stepTarget(commits, { anchor: 'c1', end: 'c1' }, 'newer')).toEqual({ anchor: 'c2', end: 'c2' });
    expect(stepTarget(commits, { anchor: 'c2', end: 'c2' }, 'older')).toEqual({ anchor: 'c1', end: 'c1' });
    expect(stepTarget(commits, { anchor: 'c3', end: 'c3' }, 'newer')).toBeNull();
    expect(stepTarget(commits, { anchor: 'c1', end: 'c1' }, 'older')).toBeNull();
  });

  it('steps off either end of a span', () => {
    expect(stepTarget(commits, { anchor: 'c2', end: 'c3' }, 'older')).toEqual({ anchor: 'c1', end: 'c1' });
    expect(stepTarget(commits, { anchor: 'c1', end: 'c2' }, 'newer')).toEqual({ anchor: 'c3', end: 'c3' });
  });

  it('has nowhere to go without commits', () => {
    expect(stepTarget([], null, 'newer')).toBeNull();
  });
});
