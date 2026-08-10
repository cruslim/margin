import { spawn } from 'node:child_process';
import type { Finding, ReviewTarget } from './types.js';
import { createWorktree, effectiveBaseSha, removeWorktree } from './worktree.js';

/** Map CodeRabbit severities onto ours. */
const SEVERITY: Record<string, Finding['severity']> = {
  critical: 'critical',
  major: 'high',
  minor: 'medium',
  trivial: 'low',
};

interface CrEvent {
  type: string;
  status?: string;
  severity?: string;
  fileName?: string;
  codegenInstructions?: string;
  message?: string;
  metadata?: { waitTime?: string };
}

function parseCrFinding(e: CrEvent): Finding {
  // The instruction text embeds the anchor as "around lines 26 - 31" and
  // starts with a fixed verification preamble ending in a blank line.
  const text = e.codegenInstructions ?? '';
  const body = text.includes('\n\n') ? text.slice(text.indexOf('\n\n') + 2) : text;
  const lineMatch = body.match(/around lines?\s+(\d+)/i);
  const firstSentence = body.match(/^[\s\S]*?[.!?](?:\s|$)/)?.[0]?.trim();
  return {
    file: e.fileName ?? '',
    line: lineMatch ? Number(lineMatch[1]) : 1,
    severity: SEVERITY[e.severity ?? ''] ?? 'medium',
    category: 'other',
    summary: firstSentence && firstSentence.length <= 220 ? firstSentence : body.slice(0, 200),
    failureScenario: body,
    snippet: '',
    source: 'coderabbit',
  };
}

/** A healthy CLI run emits status/heartbeat events every few seconds; total silence means it's wedged. */
const INACTIVITY_MS = 5 * 60_000;

/**
 * The cloud "reviewing" phase can run many minutes without a new status
 * event, which reads as dead in the agent log. Tick the elapsed time so the
 * UI shows the run is still alive (the watchdog handles actual wedges).
 */
const LIVENESS_TICK_MS = 60_000;

/** Test seam: override the spawned command, the inactivity window and the liveness tick. */
export interface CodeRabbitRunOptions {
  inactivityMs?: number;
  livenessTickMs?: number;
  spawnOverride?: { command: string; args: string[] };
}

/**
 * Run the CodeRabbit CLI as an additional finder. NOTE: this sends the diff
 * to CodeRabbit's cloud — gated behind an explicit settings opt-in.
 */
export async function runCodeRabbitReview(
  target: ReviewTarget,
  onProgress?: (line: string) => void,
  runOpts: CodeRabbitRunOptions = {},
): Promise<{ findings: Finding[] }> {
  let workDir = target.repoPath;
  let ownWorktree = false;
  if (target.headRef) {
    workDir = await createWorktree(target.repoPath, target.headRef);
    ownWorktree = true;
  }

  const args = [
    'review',
    '--agent',
    target.headRef ? '--committed' : '--uncommitted',
    '--base',
    // The resolved base commit, not the base ref: a branch rebased onto a moved
    // upstream would otherwise have this finder reviewing the upstream's commits
    // too, and reporting findings the other finders never see.
    target.headRef ? await effectiveBaseSha(target.repoPath, target.baseRef, target.headRef) : target.baseRef,
  ];

  const inactivityMs = runOpts.inactivityMs ?? INACTIVITY_MS;
  const livenessTickMs = runOpts.livenessTickMs ?? LIVENESS_TICK_MS;
  const { command, args: spawnArgs } = runOpts.spawnOverride ?? { command: 'coderabbit', args };

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, spawnArgs, { cwd: workDir, env: process.env });
      const findings: Finding[] = [];
      let buffer = '';
      let stderr = '';
      let completed = false;
      // The CLI reports failures (rate limit, auth, no base branch…) as an
      // `error` event and then exits 0, so exit code alone can't be trusted.
      let lastError = '';

      // Liveness ticker: the last phase name plus elapsed time, once a minute.
      let phase = 'working';
      const startedAt = Date.now();
      const ticker = setInterval(() => {
        const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60_000));
        onProgress?.(`[coderabbit] still ${phase} (${mins}m)`);
      }, livenessTickMs);

      // Inactivity watchdog: any output resets it, so long reviews are fine —
      // only a process that goes completely silent (hung "connecting to review
      // service") gets killed instead of pinning the whole review forever.
      let watchdog: NodeJS.Timeout;
      const resetWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          clearInterval(ticker);
          child.kill();
          reject(new Error(`coderabbit produced no output for ${Math.round(inactivityMs / 1000)}s — killed`));
        }, inactivityMs);
      };
      resetWatchdog();

      child.stdout.on('data', (chunk: Buffer) => {
        resetWatchdog();
        buffer += chunk.toString();
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          try {
            const e = JSON.parse(line) as CrEvent;
            if (e.type === 'status' && e.status) {
              phase = e.status.replace(/_/g, ' ');
              onProgress?.(`[coderabbit] ${phase}`);
            }
            if (e.type === 'finding') findings.push(parseCrFinding(e));
            if (e.type === 'complete') {
              completed = true;
              onProgress?.(`[coderabbit] done, ${findings.length} finding(s)`);
            }
            if (e.type === 'error' && e.message) {
              lastError = e.metadata?.waitTime ? `${e.message} (retry in ${e.metadata.waitTime})` : e.message;
              onProgress?.(`[coderabbit] error: ${lastError}`);
            }
          } catch {
            // non-JSON noise
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        resetWatchdog();
        stderr += chunk.toString();
      });
      child.on('error', (err) => {
        clearTimeout(watchdog);
        clearInterval(ticker);
        reject(new Error(`coderabbit CLI: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(watchdog);
        clearInterval(ticker);
        if (completed) resolve({ findings });
        else if (lastError) reject(new Error(`coderabbit: ${lastError}`));
        else if (code === 0) reject(new Error('coderabbit exited without completing the review'));
        else reject(new Error(`coderabbit exited ${code}: ${stderr.slice(0, 300)}`));
      });
    });
  } finally {
    if (ownWorktree) await removeWorktree(target.repoPath, workDir);
  }
}
