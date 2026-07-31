import { describe, expect, it } from 'vitest';
import { findingItemId, isFindingItem } from './findingItem.js';

const finding = { file: 'src/cart.js', category: 'correctness', summary: 'Off-by-one skips the last item.' };

describe('findingItemId', () => {
  it('is stable for the same finding', () => {
    expect(findingItemId(finding)).toBe(findingItemId({ ...finding }));
  });

  it('ignores position — a re-review may reorder findings while a request is out', () => {
    // Nothing about the id depends on an index, so there is nothing to go stale.
    expect(findingItemId(finding)).toBe(findingItemId({ ...finding }));
  });

  it('differs when any part of the identity differs', () => {
    const ids = new Set([
      findingItemId(finding),
      findingItemId({ ...finding, file: 'src/other.js' }),
      findingItemId({ ...finding, category: 'security' }),
      findingItemId({ ...finding, summary: 'Something else entirely.' }),
    ]);
    expect(ids.size).toBe(4);
  });

  it('is filename-safe and short', () => {
    expect(findingItemId(finding)).toMatch(/^f-[0-9a-f]{8}$/);
  });

  it('survives a summary full of path and separator characters', () => {
    const awkward = { file: 'a/b::c.ts', category: 'style', summary: 'Uses `--` and / and :: inside.' };
    expect(findingItemId(awkward)).toMatch(/^f-[0-9a-f]{8}$/);
  });
});

describe('isFindingItem', () => {
  it('recognises finding ids and rejects comment uuids', () => {
    expect(isFindingItem(findingItemId(finding))).toBe(true);
    expect(isFindingItem('3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d')).toBe(false);
  });
});
