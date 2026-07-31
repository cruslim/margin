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
      spawnOverride: { command: '/bin/sh', args: ['-c', 'for i in 1 2 3 4 5; do echo tick; sleep 0.2; done'] },
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
