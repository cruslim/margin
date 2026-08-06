import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clamp, fractionAt, readStored } from './Resizer.js';

/** Enough of the Storage API for readStored; the node env has none of its own. */
function stubStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
}

describe('clamp', () => {
  it('passes values inside the range through', () => {
    expect(clamp(0.42, 0.05, 0.95)).toBe(0.42);
  });

  it('holds at each bound', () => {
    expect(clamp(-3, 0.05, 0.95)).toBe(0.05);
    expect(clamp(99, 0.05, 0.95)).toBe(0.95);
  });
});

describe('readStored', () => {
  beforeEach(() => stubStorage());
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('falls back to the initial value when nothing is saved', () => {
    expect(readStored('margin.split.diff', 0.5, 0.05, 0.95)).toBe(0.5);
  });

  it('returns a saved value that is in range', () => {
    stubStorage({ 'margin.split.diff': '0.3' });
    expect(readStored('margin.split.diff', 0.5, 0.05, 0.95)).toBe(0.3);
  });

  it('rejects a saved value that falls outside the current bounds', () => {
    // A width saved before the min was raised, or a hand-edited entry.
    stubStorage({ 'margin.width.review': '90' });
    expect(readStored('margin.width.review', 340, 260, 720)).toBe(340);
  });

  it('rejects junk rather than yielding NaN', () => {
    stubStorage({ 'margin.split.diff': 'wide' });
    expect(readStored('margin.split.diff', 0.5, 0.05, 0.95)).toBe(0.5);
  });

  it('does not read a missing key as zero', () => {
    // Number(null) is 0, which sits inside a range spanning zero and would
    // otherwise be taken for a real saved value.
    expect(readStored('margin.split.absent', 0.5, -1, 1)).toBe(0.5);
  });
});

describe('fractionAt', () => {
  const area = { left: 200, width: 800 };

  it('maps a pointer to its share of the area', () => {
    expect(fractionAt(600, area, 0.05, 0.95)).toBe(0.5);
    expect(fractionAt(400, area, 0.05, 0.95)).toBe(0.25);
  });

  it('clamps rather than letting a side vanish', () => {
    expect(fractionAt(-500, area, 0.05, 0.95)).toBe(0.05);
    expect(fractionAt(5000, area, 0.05, 0.95)).toBe(0.95);
  });

  it('measures from the area, not the viewport', () => {
    // The diff's split starts after the line-number gutter, so a pointer at the
    // window's midpoint is not the split's midpoint.
    expect(fractionAt(200, area, 0.05, 0.95)).toBe(0.05);
  });
});
