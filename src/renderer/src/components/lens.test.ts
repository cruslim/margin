import { describe, expect, it } from 'vitest';
import { EMPTY_TREE } from '../../../shared/ipc.js';
import type { Comment, CommitInfo, Finding, LensMap } from '../../../shared/ipc.js';
import { lensComments, lensFindings, rangeOf, selectionSpan, sinceReviewSelection, tipSpan } from './lens.js';

const commit = (hash: string, parent: string): CommitInfo => ({
  sha: hash.slice(0, 3),
  hash,
  parent,
  subject: `subject ${hash}`,
  body: '',
  author: 'a',
  date: '2026-10-01T00:00:00Z',
});
// Newest first, as branchCommits lists them: c3 → c2 → c1 → (base).
const commits = [commit('c3', 'c2'), commit('c2', 'c1'), commit('c1', 'base')];

describe('selection', () => {
  it('diffs one commit against its parent', () => {
    expect(rangeOf(commits, { anchor: 'c2', end: 'c2' })).toEqual({ from: 'c1', to: 'c2' });
  });

  it('spans from the oldest commit\'s parent whichever end was clicked first', () => {
    expect(rangeOf(commits, { anchor: 'c1', end: 'c3' })).toEqual({ from: 'base', to: 'c3' });
    expect(rangeOf(commits, { anchor: 'c3', end: 'c1' })).toEqual({ from: 'base', to: 'c3' });
  });

  it('diffs a root commit against the empty tree', () => {
    expect(rangeOf([commit('r', '')], { anchor: 'r', end: 'r' })).toEqual({ from: EMPTY_TREE, to: 'r' });
  });

  it('drops a selection whose commits were rewritten', () => {
    expect(selectionSpan(commits, { anchor: 'gone', end: 'c2' })).toBeNull();
    expect(rangeOf(commits, { anchor: 'gone', end: 'gone' })).toBeNull();
    expect(rangeOf(commits, null)).toBeNull();
  });

  it('selects the commits made since the last review', () => {
    expect(sinceReviewSelection(commits, 'c1')).toEqual({ anchor: 'c2', end: 'c3' });
    // Reviewed at the tip: nothing new.
    expect(sinceReviewSelection(commits, 'c3')).toBeNull();
    // Rebased away, or never reviewed.
    expect(sinceReviewSelection(commits, 'elsewhere')).toBeNull();
    expect(sinceReviewSelection(commits, undefined)).toBeNull();
  });
});

// The commit's version is a,b,c,d,e; the tip is x,a,B,c,e — b edited in c2, d deleted in c3.
const by2 = { hash: 'c2', sha: 'c2', subject: 'edit b' };
const by3 = { hash: 'c3', sha: 'c3', subject: 'drop d' };
const lens: LensMap = {
  tipPath: 'f.ts',
  tipContent: 'x\na\nB\nc\ne\n',
  tipLine: [2, null, 4, null, 5],
  superseded: [
    { start: 2, end: 2, by: by2 },
    { start: 4, end: 4, by: by3 },
  ],
};

const comment = (over: Partial<Comment>): Comment => ({
  id: 'id',
  file: 'f.ts',
  side: 'new',
  startLine: 1,
  endLine: 1,
  messages: [],
  ...over,
});

describe('tipSpan', () => {
  it('translates a surviving line onto the tip', () => {
    expect(tipSpan(lens, 1, 1)).toEqual({ ok: true, file: 'f.ts', startLine: 2, endLine: 2 });
  });

  it('refuses a superseded line and names who changed it', () => {
    expect(tipSpan(lens, 2, 2)).toEqual({ ok: false, by: by2 });
    expect(tipSpan(lens, 3, 4)).toEqual({ ok: false, by: by3 });
  });

  it('refuses a span split apart by a later insertion', () => {
    const split: LensMap = { ...lens, tipLine: [1, 3], superseded: [] };
    expect(tipSpan(split, 1, 2)).toEqual({ ok: false, by: null });
  });

  it('refuses everything in a file deleted at the tip', () => {
    const gone: LensMap = { tipPath: null, tipContent: '', tipLine: [null], superseded: [{ start: 1, end: 1, by: by3 }] };
    expect(tipSpan(gone, 1, 1)).toEqual({ ok: false, by: by3 });
  });
});

describe('lensComments', () => {
  it('places tip comments at their commit-side lines and hides the rest', () => {
    const shown = lensComments(
      [
        comment({ id: 'a', startLine: 2, endLine: 2, quoted: 'a' }), // tip line 2 = commit line 1
        comment({ id: 'B', startLine: 3, endLine: 3, quoted: 'B' }), // written after this commit
        comment({ id: 'old', side: 'old', startLine: 1, endLine: 1 }),
        comment({ id: 'other', file: 'g.ts' }),
      ],
      lens,
    );
    expect(shown.map((c) => [c.id, c.startLine, c.endLine])).toEqual([['a', 1, 1]]);
  });

  it('re-anchors against the tip before mapping', () => {
    // Stored at tip line 1, but its quoted text has since moved to line 4.
    const shown = lensComments([comment({ startLine: 1, endLine: 1, quoted: 'c' })], lens);
    expect(shown.map((c) => c.startLine)).toEqual([3]);
  });
});

describe('lensFindings', () => {
  const finding = (line: number, snippet = ''): Finding =>
    ({ file: 'f.ts', line, snippet, category: 'bug', summary: `at ${line}`, severity: 'high' }) as unknown as Finding;

  it('maps surviving findings and drops those on code this commit doesn\'t have', () => {
    const shown = lensFindings([finding(5), finding(3), finding(1)], lens);
    expect(shown.map((f) => [f.summary, f.line])).toEqual([['at 5', 5]]);
  });

  it('shows nothing for a file deleted at the tip', () => {
    expect(lensFindings([finding(1)], { ...lens, tipPath: null })).toEqual([]);
  });
});
