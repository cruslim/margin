import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Finding, ReviewTarget } from './types.js';
import { branchDiff, createWorktree, removeWorktree, workingTreeDiff } from './worktree.js';

const SYSTEM_PROMPT = `You are Margin's verification reviewer. You receive candidate code-review findings produced by multiple reviewers of varying reliability, some of which are wrong. Adjudicate each finding against the ACTUAL code in this repository checkout.

Be skeptical — actively try to refute each finding: read the file, grep for guards, callers and types, and check whether the described failure can really occur.

Verdicts:
- "confirmed": the failure scenario is real and reachable in this code
- "refuted": it cannot happen — already guarded, factually wrong about the code, or practically impossible
- "uncertain": cannot be determined from the code alone`;

export interface VerifyResult {
  findings: Finding[];
  costUsd: number | null;
  model: string;
}

export async function verifyFindings(
  target: ReviewTarget,
  findings: Finding[],
  opts: { model?: string } = {},
  onProgress?: (line: string) => void,
): Promise<VerifyResult> {
  if (findings.length === 0) return { findings, costUsd: null, model: '' };

  let diff: string;
  let workDir: string;
  let ownWorktree = false;
  if (target.headRef) {
    diff = await branchDiff(target.repoPath, target.baseRef, target.headRef);
    workDir = await createWorktree(target.repoPath, target.headRef);
    ownWorktree = true;
  } else {
    diff = await workingTreeDiff(target.repoPath);
    workDir = target.repoPath;
  }

  const numbered = findings
    .map(
      (f, i) =>
        `${i + 1}. [${f.source ?? 'claude'}] ${f.file}:${f.line} (${f.severity}/${f.category})\n   ${f.summary}\n   Scenario: ${f.failureScenario}`,
    )
    .join('\n\n');

  const prompt = `Adjudicate the following ${findings.length} candidate finding(s) for the changeset ${target.baseRef}...${target.headRef ?? 'working tree'}. Verify each against the actual code (Read/Grep/Glob) before deciding.

FINDINGS:
${numbered}

DIFF (for context):
\`\`\`diff
${diff}
\`\`\`

When done, output ONLY a JSON object (no prose, no code fence):
{"verdicts": [{"index": 1, "verdict": "confirmed" | "refuted" | "uncertain", "reason": "<one sentence grounded in the code>"}]}
Include a verdict for every finding.`;

  try {
    let resultText = '';
    let costUsd: number | null = null;
    let model = '';

    const stream = query({
      prompt,
      options: {
        cwd: workDir,
        // User settings only — see review.ts.
        settingSources: ['user'],
        systemPrompt: SYSTEM_PROMPT,
        allowedTools: ['Read', 'Grep', 'Glob'],
        disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'],
        maxTurns: 60,
        ...(opts.model ? { model: opts.model } : {}),
        ...(process.env.MARGIN_CLI_PATH ? { pathToClaudeCodeExecutable: process.env.MARGIN_CLI_PATH } : {}),
      },
    });

    try {
      for await (const msg of stream) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          model = msg.model;
        } else if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              const input = block.input as Record<string, unknown>;
              onProgress?.(`[verifier] ${block.name} ${String(input.file_path ?? input.pattern ?? '')}`);
            }
          }
        } else if (msg.type === 'result') {
          costUsd = 'total_cost_usd' in msg ? msg.total_cost_usd : null;
          if (msg.subtype === 'success') resultText = msg.result;
          else throw new Error(`verifier session ended: ${msg.subtype}`);
        }
      }
    } catch (err) {
      if (!resultText) throw err;
    }

    const verdicts = parseVerdicts(resultText);
    const adjudicated = findings.map((f, i) => {
      const v = verdicts.get(i + 1);
      return v ? { ...f, verdict: v.verdict, verdictReason: v.reason } : { ...f, verdict: 'uncertain' as const };
    });
    const refuted = adjudicated.filter((f) => f.verdict === 'refuted').length;
    onProgress?.(`[verifier] ${findings.length - refuted} upheld, ${refuted} refuted`);
    return { findings: adjudicated, costUsd, model };
  } finally {
    if (ownWorktree) await removeWorktree(target.repoPath, workDir);
  }
}

function parseVerdicts(text: string): Map<number, { verdict: Finding['verdict']; reason: string }> {
  const map = new Map<number, { verdict: Finding['verdict']; reason: string }>();
  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === '{') starts.push(i);
  for (const start of starts) {
    for (let end = text.length - 1; end > start; end--) {
      if (text[end] !== '}') continue;
      try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as {
          verdicts?: Array<{ index: number; verdict: string; reason?: string }>;
        };
        if (Array.isArray(parsed.verdicts)) {
          for (const v of parsed.verdicts) {
            const verdict = ['confirmed', 'refuted', 'uncertain'].includes(v.verdict)
              ? (v.verdict as Finding['verdict'])
              : 'uncertain';
            map.set(v.index, { verdict, reason: v.reason ?? '' });
          }
          return map;
        }
      } catch {
        // keep scanning
      }
    }
  }
  return map;
}
