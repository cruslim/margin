import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Finding, ReviewResult, ReviewTarget, TokenUsage } from './types.js';
import { branchDiff, createWorktree, workingTreeDiff } from './worktree.js';

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

const SYSTEM_PROMPT = `You are Margin, a code reviewer. You review a diff inside a checkout of the repository.

Rules:
- Only report defects a reviewer would block a merge for: incorrect behaviour, security issues, data loss, unhandled errors, real performance problems. No style nits, no subjective preferences.
- Before reporting a finding, verify it: read the surrounding file, grep for callers or existing guards that might already handle the case. Discard anything the codebase already accounts for.
- Every finding must name a concrete failure scenario: what input or state triggers it and what goes wrong.
- Findings must anchor to a line in the NEW version of a changed file, and include the exact source snippet at that line.`;

function reviewPrompt(diff: string): string {
  return `Review the following diff. Explore the repository (Read/Grep/Glob) as needed to verify each suspicion before reporting it.

When you are done, output ONLY a JSON object (no prose before or after, no code fence) with this shape:
{
  "changeSummary": "<one paragraph: what this change does>",
  "findings": [
    {
      "file": "<repo-relative path>",
      "line": <1-indexed line in the new file version>,
      "severity": "critical" | "high" | "medium" | "low",
      "category": "correctness" | "security" | "performance" | "error-handling" | "test-coverage" | "other",
      "summary": "<one sentence stating the defect>",
      "failureScenario": "<concrete inputs/state -> wrong outcome>",
      "snippet": "<exact source line(s) the finding anchors to>"
    }
  ]
}
An empty findings array is a valid and common result.

DIFF:
\`\`\`diff
${diff}
\`\`\``;
}

export interface ReviewEvents {
  /** Called as the agent works — tool uses and text, for the live transcript. */
  onProgress?: (line: string) => void;
}

export async function runReview(target: ReviewTarget, events: ReviewEvents = {}): Promise<ReviewResult> {
  const started = Date.now();

  let diff: string;
  let workDir: string;
  if (target.headRef) {
    diff = await branchDiff(target.repoPath, target.baseRef, target.headRef);
    workDir = await createWorktree(target.repoPath, target.headRef);
  } else {
    diff = await workingTreeDiff(target.repoPath);
    // Uncommitted changes only exist in the real working copy; tools are read-only, so this is safe.
    workDir = target.repoPath;
  }
  if (!diff.trim()) {
    throw new Error('Diff is empty — nothing to review.');
  }

  let sessionId = '';
  let resultText = '';
  let costUsd: number | null = null;
  let model = '';
  let usage: TokenUsage | null = null;

  const stream = query({
    prompt: reviewPrompt(diff),
    options: {
      cwd: workDir,
      systemPrompt: SYSTEM_PROMPT,
      allowedTools: READ_ONLY_TOOLS,
      disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'],
      maxTurns: 60,
      // Inside Electron, process.execPath is Electron itself — force plain node for the CLI child.
      ...(process.versions.electron ? { executable: 'node' as const } : {}),
    },
  });

  for await (const message of stream) {
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = message.session_id;
      model = message.model;
    } else if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          events.onProgress?.(`[tool] ${block.name} ${summarizeInput(block.input)}`);
        } else if (block.type === 'text' && block.text.trim()) {
          events.onProgress?.(block.text.trim());
        }
      }
    } else if (message.type === 'result') {
      costUsd = 'total_cost_usd' in message ? message.total_cost_usd : null;
      usage = {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
      };
      if (message.subtype === 'success') {
        resultText = message.result;
      } else {
        throw new Error(`Review session ended without a result: ${message.subtype}`);
      }
    }
  }

  const parsed = parseReviewOutput(resultText);
  return {
    sessionId,
    target,
    findings: parsed.findings,
    changeSummary: parsed.changeSummary,
    model,
    usage,
    costUsd,
    durationMs: Date.now() - started,
    workDir,
  };
}

function summarizeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    return String(o.file_path ?? o.pattern ?? o.path ?? '');
  }
  return '';
}

function parseReviewOutput(text: string): { changeSummary: string; findings: Finding[] } {
  // The agent is told to emit bare JSON, but tolerate a stray code fence or leading prose.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error(`Review output contained no JSON object:\n${text}`);
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    changeSummary?: string;
    findings?: Finding[];
  };
  return {
    changeSummary: parsed.changeSummary ?? '',
    findings: parsed.findings ?? [],
  };
}
