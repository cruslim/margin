import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { parseCrInstructions, runCodeRabbitReview } from './coderabbit.js';

// headRef null → runs in repoPath directly, no worktree needed.
const target = { repoPath: tmpdir(), baseRef: 'main', headRef: null };

describe('coderabbit inactivity watchdog', () => {
  it('kills a process that goes completely silent', async () => {
    const start = Date.now();
    await expect(
      runCodeRabbitReview(target, undefined, {
        inactivityMs: 300,
        spawnOverride: { command: 'sleep', args: ['30'] },
      }),
    ).rejects.toThrow(/no output for/);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('does not fire while output keeps flowing, even past the window', async () => {
    // ~1s total runtime with a 500ms window, but every gap is only 200ms.
    const result = await runCodeRabbitReview(target, undefined, {
      inactivityMs: 500,
      spawnOverride: {
        command: '/bin/sh',
        args: ['-c', 'for i in 1 2 3 4 5; do echo tick; sleep 0.2; done; echo \'{"type":"complete","status":"review_completed"}\''],
      },
    });
    expect(result).toEqual({ findings: [] });
  });

  it('still reports non-zero exits with stderr', async () => {
    await expect(
      runCodeRabbitReview(target, undefined, {
        inactivityMs: 5000,
        spawnOverride: { command: '/bin/sh', args: ['-c', 'echo boom >&2; exit 3'] },
      }),
    ).rejects.toThrow(/exited 3: boom/);
  });
});

describe('parseCrInstructions', () => {
  it('reads the inline "around lines" anchor after the verification preamble', () => {
    expect(parseCrInstructions('Verify this first.\n\nIn @util.js around lines 4 - 6, handle undefined.')).toEqual({
      line: 4,
      body: 'In @util.js around lines 4 - 6, handle undefined.',
    });
  });

  it('reads the newer "Review comment at … at line N:" header and drops it from the body', () => {
    // The shape the CLI emits now: a header line, then the instruction. Before
    // this was handled the finding landed on line 1 with the header as its summary.
    const text =
      'Review comment at @assets/src/lib/url.ts at line 33:\nUpdate the parser to reject page numbers above 2147483647.';
    expect(parseCrInstructions(text)).toEqual({
      line: 33,
      body: 'Update the parser to reject page numbers above 2147483647.',
    });
    expect(parseCrInstructions('Review comment at @a.ts at lines 7 - 9:\nFix it.')).toEqual({ line: 7, body: 'Fix it.' });
  });

  it('falls back to line 1 with the whole text when no anchor is present', () => {
    expect(parseCrInstructions('Just a note.')).toEqual({ line: 1, body: 'Just a note.' });
  });
});

describe('coderabbit event stream', () => {
  const emit = (...lines: string[]) => ({
    command: '/bin/sh',
    args: ['-c', lines.map((l) => `echo '${l}'`).join('; ')],
  });

  it('parses findings from a completed review', async () => {
    const result = await runCodeRabbitReview(target, undefined, {
      inactivityMs: 5000,
      spawnOverride: emit(
        '{"type":"status","phase":"analyzing","status":"reviewing"}',
        '{"type":"finding","severity":"major","fileName":"util.js","codegenInstructions":"In @util.js around lines 4 - 6, handle undefined."}',
        '{"type":"complete","status":"review_completed","findings":1}',
      ),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ file: 'util.js', line: 4, severity: 'high', source: 'coderabbit' });
  });

  it('rejects when the CLI reports an error event and exits 0', async () => {
    // Real failure mode: rate limit / auth / branch errors arrive as an
    // `error` event followed by exit code 0.
    await expect(
      runCodeRabbitReview(target, undefined, {
        inactivityMs: 5000,
        spawnOverride: emit(
          '{"type":"status","phase":"connecting","status":"connecting_to_review_service"}',
          '{"type":"error","errorType":"rate_limit","message":"Rate limit exceeded","recoverable":true,"metadata":{"waitTime":"31 minutes"}}',
        ),
      }),
    ).rejects.toThrow(/Rate limit exceeded \(retry in 31 minutes\)/);
  });

  it('rejects a clean exit that never completed the review', async () => {
    await expect(
      runCodeRabbitReview(target, undefined, {
        inactivityMs: 5000,
        spawnOverride: emit('{"type":"status","phase":"connecting","status":"connecting_to_review_service"}'),
      }),
    ).rejects.toThrow(/without completing/);
  });
});

describe('coderabbit liveness ticker', () => {
  it('reports the current phase periodically during long quiet stretches', async () => {
    const lines: string[] = [];
    // Status, then a quiet second (output every 300ms feeds the watchdog,
    // but non-JSON lines produce no log entries), then completion.
    await runCodeRabbitReview(target, (l) => lines.push(l), {
      inactivityMs: 5000,
      livenessTickMs: 400,
      spawnOverride: {
        command: '/bin/sh',
        args: [
          '-c',
          `echo '{"type":"status","phase":"analyzing","status":"reviewing"}'; for i in 1 2 3 4; do echo tick; sleep 0.3; done; echo '{"type":"complete","status":"review_completed"}'`,
        ],
      },
    });
    const ticks = lines.filter((l) => l.includes('still reviewing'));
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[0]).toMatch(/\[coderabbit\] still reviewing \(1m\)/);
  });

  it('stops ticking once the process exits', async () => {
    const lines: string[] = [];
    await runCodeRabbitReview(target, (l) => lines.push(l), {
      inactivityMs: 5000,
      livenessTickMs: 100,
      spawnOverride: { command: '/bin/sh', args: ['-c', `echo '{"type":"complete","status":"review_completed"}'`] },
    });
    const before = lines.filter((l) => l.includes('still')).length;
    await new Promise((r) => setTimeout(r, 300));
    expect(lines.filter((l) => l.includes('still')).length).toBe(before);
  });
});
