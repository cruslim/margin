import { spawn } from 'node:child_process';
import type { Finding, ReviewTarget } from './types.js';
import { createWorktree, removeWorktree } from './worktree.js';

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

/**
 * Run the CodeRabbit CLI as an additional finder. NOTE: this sends the diff
 * to CodeRabbit's cloud — gated behind an explicit settings opt-in.
 */
export async function runCodeRabbitReview(
  target: ReviewTarget,
  onProgress?: (line: string) => void,
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
    '--type',
    target.headRef ? 'committed' : 'uncommitted',
    '--base',
    target.baseRef,
  ];

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn('coderabbit', args, { cwd: workDir, env: process.env });
      const findings: Finding[] = [];
      let buffer = '';
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          try {
            const e = JSON.parse(line) as CrEvent;
            if (e.type === 'status' && e.status) onProgress?.(`[coderabbit] ${e.status.replace(/_/g, ' ')}`);
            if (e.type === 'finding') findings.push(parseCrFinding(e));
            if (e.type === 'complete') onProgress?.(`[coderabbit] done, ${findings.length} finding(s)`);
          } catch {
            // non-JSON noise
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (err) => reject(new Error(`coderabbit CLI: ${err.message}`)));
      child.on('close', (code) => {
        if (code === 0) resolve({ findings });
        else reject(new Error(`coderabbit exited ${code}: ${stderr.slice(0, 300)}`));
      });
    });
  } finally {
    if (ownWorktree) await removeWorktree(target.repoPath, workDir);
  }
}
