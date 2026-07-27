import { describe, expect, it } from 'vitest';
import { parseReviewOutput } from './review.js';

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
