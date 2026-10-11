import { describe, expect, it } from 'vitest';
import { commentTarget, emptySideFraction, revealCandidates, splitGeometry } from './DiffPane.js';

describe('emptySideFraction', () => {
  it('leaves an ordinary diff to the saved preference', () => {
    expect(emptySideFraction({ oldContent: 'a\n', newContent: 'b\n' })).toBeNull();
  });

  it('narrows the old side of an added file', () => {
    // The case that started this: a whole new file, half the pane left blank.
    expect(emptySideFraction({ oldContent: '', newContent: '<?php\n' })).toBeCloseTo(0.1);
  });

  it('narrows the new side of a deleted file', () => {
    expect(emptySideFraction({ oldContent: '<?php\n', newContent: '' })).toBeCloseTo(0.9);
  });

  it('has no opinion before the diff loads', () => {
    expect(emptySideFraction(null)).toBeNull();
  });
});

describe('splitGeometry', () => {
  // A 1000px pane whose two line-number gutters take 50px each.
  const geom = { gutter: 50, width: 1000 };

  it('divides the space left after both gutters', () => {
    expect(splitGeometry(geom, 0.5)).toEqual({ contentWidth: 900, oldColumn: 450, dividerX: 500 });
  });

  it('places the divider past the gutter, so it lands on the seam', () => {
    // Not 250: the old column starts after its own gutter.
    expect(splitGeometry(geom, 0.25).dividerX).toBe(275);
  });

  it('keeps the old column and the divider consistent', () => {
    const { oldColumn, dividerX } = splitGeometry(geom, 0.8);
    expect(dividerX).toBe(geom.gutter + oldColumn);
  });

  it('reports no width before the table has been measured', () => {
    // Guards the divider against rendering at a nonsense offset on first paint.
    expect(splitGeometry({ gutter: 0, width: 0 }, 0.5).contentWidth).toBe(0);
  });

  it('does not go negative when the gutters exceed the pane', () => {
    expect(splitGeometry({ gutter: 50, width: 40 }, 0.5).contentWidth).toBe(0);
  });
});

describe('revealCandidates', () => {
  it('offers the unresolved threads', () => {
    const got = revealCandidates([
      { id: 'a', resolved: true },
      { id: 'b' },
      { id: 'c' },
    ]);
    expect(got).toEqual(new Set(['b', 'c']));
  });

  it('falls back to every thread once they are all resolved', () => {
    // The icon is still shown for a settled file, so it still has to go somewhere.
    const got = revealCandidates([
      { id: 'a', resolved: true },
      { id: 'b', resolved: true },
    ]);
    expect(got).toEqual(new Set(['a', 'b']));
  });

  it('offers nothing for a file with no threads', () => {
    expect(revealCandidates([]).size).toBe(0);
  });
});

describe('commentTarget', () => {
  // Commit version a,b,c; at the tip b was rewritten and a line inserted on top.
  const lens = {
    tipPath: 'moved.ts',
    tipContent: 'x\na\nB\nc\n',
    tipLine: [2, null, 4],
    superseded: [{ start: 2, end: 2, by: { hash: 'h2', sha: 'h2', subject: 'rewrite b' } }],
  };

  it('keeps a comment where it was made outside commit view', () => {
    expect(commentTarget(undefined, 'f.ts', 'old', 3, 4)).toEqual({ ok: true, file: 'f.ts', startLine: 3, endLine: 4 });
  });

  it('moves a commit-view comment onto the tip, following a rename', () => {
    expect(commentTarget(lens, 'f.ts', 'new', 3, 3)).toEqual({ ok: true, file: 'moved.ts', startLine: 4, endLine: 4 });
  });

  it('refuses removed lines and superseded code in commit view', () => {
    expect(commentTarget(lens, 'f.ts', 'old', 1, 1)).toEqual({ ok: false, reason: 'old', by: null });
    expect(commentTarget(lens, 'f.ts', 'new', 1, 2)).toEqual({
      ok: false,
      reason: 'superseded',
      by: { hash: 'h2', sha: 'h2', subject: 'rewrite b' },
    });
  });
});
