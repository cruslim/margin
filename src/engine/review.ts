import { query } from '@anthropic-ai/claude-agent-sdk';
import { mergeInstructions, readRepoInstructionsFile } from './instructions.js';
import type { Finding, ReviewOptions, ReviewResult, ReviewTarget, TokenUsage } from './types.js';
import { branchDiff, createWorktree, resolveSha, workingTreeDiff } from './worktree.js';

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

const SYSTEM_PROMPT = `You are Margin, a code reviewer. You review a diff inside a checkout of the repository.

Rules:
- Only report defects a reviewer would block a merge for: incorrect behaviour, security issues, data loss, unhandled errors, real performance problems. No style nits, no subjective preferences.
- Before reporting a finding, verify it: read the surrounding file, grep for callers or existing guards that might already handle the case. Discard anything the codebase already accounts for.
- Every finding must name a concrete failure scenario: what input or state triggers it and what goes wrong.
- Findings must anchor to a line in the NEW version of a changed file, and include the exact source snippet at that line.`;

function reviewPrompt(diff: string, opts: ReviewOptions, projectInstructions: string): string {
  let preamble = '';
  if (opts.sinceSha) {
    preamble +=
      'This is an INCREMENTAL review: the diff below contains only changes made since your previous review of this branch. Review just these new changes.\n\n';
  }
  if (projectInstructions.trim()) {
    preamble += `Project-specific review instructions (follow these):\n${projectInstructions.trim()}\n\n`;
  }
  if (opts.dismissed?.length) {
    preamble +=
      'The user has dismissed the following findings — do NOT report these or trivial variations of them again:\n' +
      opts.dismissed.map((d) => `- ${d.file} [${d.category}]: ${d.summary}`).join('\n') +
      '\n\n';
  }
  return `${preamble}Review the following diff. Explore the repository (Read/Grep/Glob) as needed to verify each suspicion before reporting it.

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

export async function runReview(
  target: ReviewTarget,
  events: ReviewEvents = {},
  opts: ReviewOptions = {},
): Promise<ReviewResult> {
  const started = Date.now();

  let diff: string;
  let workDir: string;
  let headSha: string | null = null;
  if (target.headRef) {
    headSha = await resolveSha(target.repoPath, target.headRef);
    diff = await branchDiff(target.repoPath, opts.sinceSha ?? target.baseRef, target.headRef);
    workDir = await createWorktree(target.repoPath, target.headRef);
  } else {
    diff = await workingTreeDiff(target.repoPath);
    // Uncommitted changes only exist in the real working copy; tools are read-only, so this is safe.
    workDir = target.repoPath;
  }
  if (!diff.trim()) {
    throw new Error(
      opts.sinceSha ? 'No new changes since the last review.' : 'Diff is empty — nothing to review.',
    );
  }

  const projectInstructions = mergeInstructions(opts.instructions, await readRepoInstructionsFile(workDir));

  let sessionId = '';
  let resultText = '';
  let costUsd: number | null = null;
  let model = '';
  let usage: TokenUsage | null = null;

  const stream = query({
    prompt: reviewPrompt(diff, opts, projectInstructions),
    options: {
      cwd: workDir,
      systemPrompt: SYSTEM_PROMPT,
      allowedTools: READ_ONLY_TOOLS,
      disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'],
      maxTurns: 60,
      ...(opts.model ? { model: opts.model } : {}),
      // Inside Electron, process.execPath is Electron itself — force plain node for the CLI child.
      ...(process.versions.electron ? { executable: 'node' as const } : {}),
      // Packaged app: the SDK's own cli.js path resolves inside the asar; use the unpacked copy.
      ...(process.env.MARGIN_CLI_PATH ? { pathToClaudeCodeExecutable: process.env.MARGIN_CLI_PATH } : {}),
    },
  });

  try {
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
  } catch (err) {
    // Some models' CLI sessions exit non-zero after already delivering the
    // result — don't discard a completed review over a shutdown error.
    if (!resultText) throw err;
  }

  const parsed = parseReviewOutput(resultText);
  return {
    sessionId,
    target,
    findings: parsed.findings,
    changeSummary: parsed.changeSummary,
    model,
    headSha,
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

export function parseReviewOutput(text: string): { changeSummary: string; findings: Finding[] } {
  // The agent is told to emit bare JSON, but its message may contain stray
  // braces in surrounding prose (e.g. inline "{type: 'percent'}" examples).
  // Try candidate {...} spans until one parses to the expected shape.
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') starts.push(i);
    else if (text[i] === '}') ends.push(i);
  }
  for (const start of starts) {
    for (let e = ends.length - 1; e >= 0; e--) {
      const end = ends[e];
      if (end <= start) break;
      try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as {
          changeSummary?: string;
          findings?: Finding[];
        };
        if (parsed.changeSummary !== undefined || Array.isArray(parsed.findings)) {
          return { changeSummary: parsed.changeSummary ?? '', findings: parsed.findings ?? [] };
        }
      } catch {
        // keep scanning
      }
    }
  }
  throw new Error(`Review output contained no parseable review JSON:\n${text}`);
}
