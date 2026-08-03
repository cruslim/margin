import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runCodeRabbitReview } from './coderabbit.js';

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
