import { describe, expect, it } from 'vitest';
import { reanchor } from './reanchor.js';

const file = (...lines: string[]) => lines.join('\n');

describe('reanchor', () => {
  const content = file(
    'import { a } from "a";',      // 1
    '',                            // 2
    'export function go(x) {',     // 3
    '  if (!x) return null;',      // 4
    '  return x * 2;',             // 5
    '}',                           // 6
  );

  it('leaves a still-correct anchor alone', () => {
    expect(reanchor(content, { startLine: 4, endLine: 4 }, '  if (!x) return null;')).toEqual({
      startLine: 4,
      endLine: 4,
    });
  });

  it('follows the code when lines are inserted above', () => {
    const shifted = file('// new header', '// more', ...content.split('\n'));
    expect(reanchor(shifted, { startLine: 4, endLine: 4 }, '  if (!x) return null;')).toEqual({
      startLine: 6,
      endLine: 6,
    });
  });

  it('follows the code when lines are removed above', () => {
    const shifted = file(...content.split('\n').slice(2));
    expect(reanchor(shifted, { startLine: 4, endLine: 4 }, '  if (!x) return null;')).toEqual({
      startLine: 2,
      endLine: 2,
    });
  });

  it('re-anchors a multi-line range and keeps its span', () => {
    const shifted = file('// header', ...content.split('\n'));
    const quoted = file('  if (!x) return null;', '  return x * 2;');
    expect(reanchor(shifted, { startLine: 4, endLine: 5 }, quoted)).toEqual({
      startLine: 5,
      endLine: 6,
    });
  });

  it('keeps the anchor when the quoted code is gone', () => {
    expect(reanchor(content, { startLine: 4, endLine: 4 }, '  throw new Error("deleted");')).toEqual({
      startLine: 4,
      endLine: 4,
    });
  });

  it('picks the nearest match when the line is duplicated', () => {
    const dup = file(
      '  guard();',   // 1
      'a();',         // 2
      'b();',         // 3
      'c();',         // 4
      '  guard();',   // 5
    );
    // anchored at 4 originally → nearest duplicate is line 5, not line 1
    expect(reanchor(dup, { startLine: 4, endLine: 4 }, '  guard();')).toEqual({
      startLine: 5,
      endLine: 5,
    });
  });

  it('breaks an equidistant tie toward the earlier match', () => {
    const dup = file('  guard();', 'a();', 'x();', 'b();', '  guard();');
    // anchor at line 3 sits exactly between the two — deterministic, not arbitrary
    expect(reanchor(dup, { startLine: 3, endLine: 3 }, '  guard();')).toEqual({
      startLine: 1,
      endLine: 1,
    });
  });

  it('is a no-op without a usable quote', () => {
    const anchor = { startLine: 4, endLine: 4 };
    expect(reanchor(content, anchor, undefined)).toBe(anchor);
    expect(reanchor(content, anchor, '')).toBe(anchor);
    expect(reanchor(content, anchor, '   \n  ')).toBe(anchor);
  });

  it('survives an anchor pointing past the end of the file', () => {
    expect(reanchor(content, { startLine: 999, endLine: 999 }, '  return x * 2;')).toEqual({
      startLine: 5,
      endLine: 5,
    });
  });
});
