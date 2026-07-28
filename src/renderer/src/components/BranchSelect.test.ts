import { describe, expect, it } from 'vitest';
import { filterOptions, type BranchOption } from './BranchSelect.js';

const opts: BranchOption[] = [
  { value: '__working__', label: 'uncommitted changes' },
  { value: 'feat/quote-comparison', label: 'feat/quote-comparison' },
  { value: 'cruslim/DISCOVER-111', label: 'cruslim/DISCOVER-111' },
  { value: 'master', label: 'master' },
];

describe('filterOptions', () => {
  it('returns all options unchanged for an empty query', () => {
    expect(filterOptions(opts, '')).toEqual(opts);
    expect(filterOptions(opts, '   ')).toEqual(opts);
  });

  it('matches case-insensitively anywhere in the label', () => {
    expect(filterOptions(opts, 'discover').map((o) => o.value)).toEqual(['cruslim/DISCOVER-111']);
    expect(filterOptions(opts, 'QUOTE').map((o) => o.value)).toEqual(['feat/quote-comparison']);
  });

  it('preserves the incoming order (newest-first from git)', () => {
    expect(filterOptions(opts, 'm').map((o) => o.value)).toEqual([
      '__working__',
      'feat/quote-comparison',
      'cruslim/DISCOVER-111',
      'master',
    ]);
  });

  it('returns empty when nothing matches', () => {
    expect(filterOptions(opts, 'zzz')).toEqual([]);
  });
});
