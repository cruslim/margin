import { describe, expect, it } from 'vitest';
import { sessionToMarkdown } from './exportMarkdown.js';
import type { Session } from './ipc.js';
import type { Finding } from '../engine/types.js';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: 'src/cart.ts',
    line: 42,
    severity: 'high',
    category: 'correctness',
    summary: 'Total ignores quantity',
    failureScenario: 'Two of the same item charge for one.',
    snippet: 'const total = items.reduce((t, i) => t + i.price, 0);',
    ...over,
  };
}

function session(over: Partial<Session> = {}): Session {
  return {
    key: 'k1',
    createdAt: Date.UTC(2026, 7, 18),
    repoPath: '/repo',
    repoName: 'shop',
    baseRef: 'main',
    headRef: 'feature/cart',
    status: 'done',
    transcript: [],
    findings: [],
    changeSummary: 'Adds a shopping cart.',
    costUsd: 0.42,
    model: 'sonnet',
    ...over,
  };
}

describe('sessionToMarkdown', () => {
  it('renders header, meta and summary', () => {
    const md = sessionToMarkdown(session());
    expect(md).toContain('# Margin review: shop — feature/cart vs main');
    expect(md).toContain('*2026-08-18 · model sonnet · $0.42 · 0 findings*');
    expect(md).toContain('Adds a shopping cart.');
    expect(md).toContain('None.');
  });

  it('names the working tree when there is no head ref', () => {
    const md = sessionToMarkdown(session({ headRef: null }));
    expect(md).toContain('# Margin review: shop — uncommitted changes vs main');
  });

  it('sorts findings by severity and keeps threads with their finding', () => {
    const s = session({
      findings: [finding({ severity: 'low', summary: 'nit' }), finding({ severity: 'critical', summary: 'boom' })],
      threads: { 1: [{ role: 'user', text: 'why?', at: 1 }, { role: 'assistant', text: 'because', at: 2 }] },
    });
    const md = sessionToMarkdown(s);
    expect(md.indexOf('boom')).toBeLessThan(md.indexOf('nit'));
    // The thread is keyed by original index 1 (critical), not sorted position.
    const critical = md.slice(md.indexOf('boom'), md.indexOf('nit'));
    expect(critical).toContain('> **You:** why?');
    expect(critical).toContain('> **Margin:** because');
  });

  it('shows verdicts and finder source', () => {
    const md = sessionToMarkdown(
      session({
        findings: [
          finding({ verdict: 'confirmed', verdictReason: 'reproduced' }),
          finding({ summary: 'maybe', verdict: 'uncertain', source: 'gpt-5' }),
        ],
      }),
    );
    expect(md).toContain('✓ verified — reproduced');
    expect(md).toContain('found by gpt-5');
    expect(md).toContain('? unverified');
  });

  it('moves refuted findings to their own one-liner section', () => {
    const md = sessionToMarkdown(
      session({ findings: [finding({ verdict: 'refuted', verdictReason: 'guarded upstream' })] }),
    );
    expect(md).toContain('## Refuted by verifier (1)');
    expect(md).toContain('- `src/cart.ts:42` — Total ignores quantity — guarded upstream');
    // Not double-reported as a full finding.
    expect(md).not.toContain('### `src/cart.ts:42`');
  });

  it('excludes dismissed findings via the passed filter', () => {
    const md = sessionToMarkdown(session({ findings: [finding()] }), {
      isDismissed: (f) => f.summary === 'Total ignores quantity',
    });
    expect(md).toContain('0 findings');
    expect(md).not.toContain('Total ignores quantity');
  });

  it('renders comment threads sorted by file and line, with resolution and replier', () => {
    const md = sessionToMarkdown(
      session({
        comments: [
          {
            id: 'b',
            file: 'src/b.ts',
            side: 'new',
            startLine: 5,
            endLine: 9,
            resolved: true,
            quoted: 'const x = 1;',
            messages: [{ role: 'user', text: 'rename?', at: 1 }, { role: 'assistant', text: 'done', at: 2 }],
            external: true,
          },
          {
            id: 'a',
            file: 'src/a.ts',
            side: 'new',
            startLine: 3,
            endLine: 3,
            messages: [{ role: 'user', text: 'hm', at: 1 }, { role: 'assistant', text: 'ack', at: 2 }],
            agent: 'security',
          },
        ],
      }),
    );
    expect(md.indexOf('src/a.ts:3')).toBeLessThan(md.indexOf('src/b.ts:5–9'));
    expect(md).toContain('### `src/b.ts:5–9` — resolved ✓');
    expect(md).toContain('> **Your agent:** done');
    expect(md).toContain('> **@security:** ack');
  });

  it('survives backtick fences inside snippets', () => {
    const md = sessionToMarkdown(session({ findings: [finding({ snippet: 'docs = "```md\\n```"' })] }));
    // The fence must be longer than the three-backtick run in the snippet.
    expect(md).toContain('````ts');
  });

  it('renders specialist reports with per-check marks and skip reasons', () => {
    const md = sessionToMarkdown(
      session({
        specialistReports: [
          {
            agent: 'security',
            ran: true,
            reason: 'The diff touches auth.',
            checks: [
              { check: 'injection', status: 'pass', note: 'parameterized everywhere' },
              { check: 'secrets logged', status: 'finding', note: 'token written to debug log' },
            ],
            costUsd: 0.03,
          },
          { agent: 'performance', ran: false, reason: 'No hot paths touched.', checks: [], costUsd: null },
        ],
      }),
    );
    expect(md).toContain('## Checked by specialists');
    expect(md).toContain('### @security');
    expect(md).toContain('- ✓ injection — parameterized everywhere');
    expect(md).toContain('- ✗ secrets logged — token written to debug log');
    expect(md).toContain('### @performance — skipped');
    expect(md).toContain('No hot paths touched.');
  });

  it('quotes multi-line replies line by line', () => {
    const md = sessionToMarkdown(
      session({
        findings: [finding()],
        threads: { 0: [{ role: 'assistant', text: 'first\n\nsecond', at: 1 }] },
      }),
    );
    expect(md).toContain('> **Margin:** first\n>\n> second');
  });
});
