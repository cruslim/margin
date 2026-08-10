import { describe, expect, it } from 'vitest';
import { baseLabel } from './baseLabel.js';

describe('baseLabel', () => {
  it('names the session base alone when the refs agree', () => {
    expect(baseLabel('master', { })).toEqual({ ref: 'master' });
    expect(baseLabel('master', undefined)).toEqual({ ref: 'master' });
  });

  it('names the advanced ref, and how far the session base lags it', () => {
    const label = baseLabel('master', { baseVia: { ref: 'origin/master', behind: 2, landed: false } });
    expect(label.ref).toBe('origin/master');
    // "on local" distinguishes it from the remote ref of the same name shown beside it.
    expect(label.note).toBe('master on local is 2 behind');
    expect(label.detail).toContain('your local master is 2 commit(s) behind');
    expect(label.merged).toBeUndefined();
  });

  it('names a merged base as the original base, without a count that reads as being about the new ref', () => {
    const label = baseLabel('stack-parent', { baseVia: { ref: 'master', behind: 103, landed: true } });
    expect(label.ref).toBe('master');
    expect(label.note).toBe('original base stack-parent has been merged');
    expect(label.note).not.toContain('103');
    // The number still belongs in the tooltip, where it has room to say what it counts.
    expect(label.detail).toContain('103 commit(s) further on');
  });

  it('stays on the session base for a branch that has already landed, and flags it', () => {
    const label = baseLabel('master', { mergedInto: 'origin/master' });
    expect(label.ref).toBe('master');
    expect(label.note).toBe('already in origin/master');
    expect(label.merged).toBe('origin/master');
  });

  // The two can't both hold — resolveBase returns mergedInto instead of advancing —
  // but if that ever changed, the advanced base is the one the changeset used.
  it('prefers the advanced ref if both are somehow set', () => {
    const label = baseLabel('master', {
      baseVia: { ref: 'origin/master', behind: 1, landed: false },
      mergedInto: 'origin/master',
    });
    expect(label.ref).toBe('origin/master');
    expect(label.merged).toBeUndefined();
  });
});
