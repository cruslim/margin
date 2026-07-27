import { describe, expect, it } from 'vitest';
import { splitDiffBlocks } from './ChatParts.js';

describe('splitDiffBlocks', () => {
  it('returns plain text as a single part', () => {
    expect(splitDiffBlocks('just prose')).toEqual([{ type: 'text', content: 'just prose' }]);
  });

  it('splits a diff fence out of surrounding text', () => {
    const msg = 'Explanation first.\n```diff\n-a\n+b\n```\nAnd after.';
    expect(splitDiffBlocks(msg)).toEqual([
      { type: 'text', content: 'Explanation first.' },
      { type: 'diff', content: '-a\n+b\n' },
      { type: 'text', content: 'And after.' },
    ]);
  });

  it('handles multiple diff fences', () => {
    const msg = '```diff\n-x\n```\nmiddle\n```diff\n+y\n```';
    const parts = splitDiffBlocks(msg);
    expect(parts.map((p) => p.type)).toEqual(['diff', 'text', 'diff']);
  });

  it('drops empty segments', () => {
    const parts = splitDiffBlocks('```diff\n-a\n+b\n```');
    expect(parts).toEqual([{ type: 'diff', content: '-a\n+b\n' }]);
  });

  it('leaves non-diff fences alone', () => {
    const msg = '```ts\nconst x = 1;\n```';
    expect(splitDiffBlocks(msg)).toEqual([{ type: 'text', content: msg }]);
  });
});
