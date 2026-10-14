import { describe, expect, it } from 'vitest';
import { parseReviewOutput, reviewPrompt, TRANSIENT_API_ERROR } from './review.js';

const finding = {
  file: 'src/a.ts',
  line: 3,
  severity: 'high',
  category: 'correctness',
  summary: 'off-by-one',
  failureScenario: 'last item skipped',
  snippet: 'for (let i = 0; i < n - 1; i++)',
};

describe('parseReviewOutput', () => {
  it('parses bare JSON', () => {
    const out = parseReviewOutput(JSON.stringify({ changeSummary: 'adds x', findings: [finding] }));
    expect(out.changeSummary).toBe('adds x');
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0].summary).toBe('off-by-one');
  });

  it('extracts JSON surrounded by prose', () => {
    const text = `Here is my review.\n\n${JSON.stringify({ changeSummary: 's', findings: [] })}\n\nDone.`;
    expect(parseReviewOutput(text)).toEqual({ changeSummary: 's', findings: [] });
  });

  it('survives stray braces in surrounding prose', () => {
    const text = `Note the {type: 'percent'} example above.\n${JSON.stringify({ findings: [finding] })}\ntrailing {junk}`;
    expect(parseReviewOutput(text).findings).toHaveLength(1);
  });

  it('defaults missing fields', () => {
    expect(parseReviewOutput('{"findings": []}')).toEqual({ changeSummary: '', findings: [] });
    expect(parseReviewOutput('{"changeSummary": "only summary"}').findings).toEqual([]);
  });

  it('throws when no review JSON is present', () => {
    expect(() => parseReviewOutput('no json here')).toThrow(/no parseable review JSON/);
    // A JSON object of the wrong shape is not a review payload.
    expect(() => parseReviewOutput('{"foo": 1}')).toThrow(/no parseable review JSON/);
  });
});

describe('TRANSIENT_API_ERROR', () => {
  it('matches server-side blips worth a retry', () => {
    expect(
      TRANSIENT_API_ERROR.test(
        'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
      ),
    ).toBe(true);
    expect(TRANSIENT_API_ERROR.test('API Error: 529 overloaded_error')).toBe(true);
    expect(TRANSIENT_API_ERROR.test('Error: Overloaded')).toBe(true);
  });

  it('does not match caller mistakes', () => {
    expect(TRANSIENT_API_ERROR.test('No new changes since the last review.')).toBe(false);
    expect(TRANSIENT_API_ERROR.test('API Error: 401 authentication_error')).toBe(false);
    expect(TRANSIENT_API_ERROR.test('Diff is empty — nothing to review.')).toBe(false);
  });
});

describe('reviewPrompt', () => {
  it('leads with the repo conventions when there are any, ahead of the diff', () => {
    const prompt = reviewPrompt('diff body', {}, 'Use tabs.', '--- CLAUDE.md ---\nMax 10 deps.');
    expect(prompt.indexOf('Max 10 deps.')).toBeLessThan(prompt.indexOf('Use tabs.'));
    expect(prompt.indexOf('Use tabs.')).toBeLessThan(prompt.indexOf('diff body'));
  });

  it('carries no conventions block when the repo has none', () => {
    const prompt = reviewPrompt('diff body', {}, '');
    expect(prompt).not.toContain('CLAUDE.md');
    expect(prompt).toContain('diff body');
  });
});
