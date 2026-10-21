import { query } from '@anthropic-ai/claude-agent-sdk';
import { generatedFilesNote } from '../shared/generated.js';
import { conventionsPreamble, mergeInstructions, readRepoConventions, readRepoInstructionsFile } from './instructions.js';
import { queryAbort, ReviewCancelledError, throwIfCancelled } from './types.js';
import type { Finding, ReviewOptions, ReviewResult, ReviewTarget, TokenUsage } from './types.js';
import { branchDiff, createWorktree, resolveSha, usableSinceSha, workingTreeDiff } from './worktree.js';

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

/** Errors worth one automatic retry: server-side blips, not caller mistakes. */
export const TRANSIENT_API_ERROR = /API Error: 5\d\d|internal server error|overloaded/i;

const SYSTEM_PROMPT = `You are Margin, a code reviewer. You review a diff inside a checkout of the repository.

Rules:
- Only report defects a reviewer would block a merge for: incorrect behaviour, security issues, data loss, unhandled errors, real performance problems. No style nits, no subjective preferences.
- Before reporting a finding, verify it: read the surrounding file, grep for callers or existing guards that might already handle the case. Discard anything the codebase already accounts for.
- Follow every value the change newly takes from outside the program — a URL or query parameter, a request body, header or cookie, storage, a file, the environment — to each place it is consumed, across language and process boundaries (a client parameter into the server resolver and query behind it). Ask what an unexpected, extreme or hostile value does there.
- Code the diff did not touch is in scope when the change makes it newly reachable, or reachable with such a value. "Pre-existing" only excuses a problem the change neither exposes nor worsens.
- Every finding must name a concrete failure scenario: what input or state triggers it and what goes wrong.
- Findings must anchor to a line in the NEW version of a changed file, and include the exact source snippet at that line.`;

export function reviewPrompt(
  diff: string,
  opts: ReviewOptions,
  projectInstructions: string,
  conventions = '',
): string {
  let preamble = conventionsPreamble(conventions);
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
  preamble += generatedFilesNote(diff);
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
  // A rebase since the last review orphans sinceSha, which would make the
  // "incremental" diff quietly span the whole branch — review it all, and say so.
  const sinceSha = target.headRef
    ? await usableSinceSha(target.repoPath, opts.sinceSha, target.headRef)
    : undefined;
  if (opts.sinceSha && !sinceSha) {
    events.onProgress?.('[review] branch was rebased since the last review — reviewing the full changeset.');
  }
  opts = { ...opts, sinceSha };

  if (target.headRef) {
    headSha = await resolveSha(target.repoPath, target.headRef);
    diff = await branchDiff(target.repoPath, sinceSha ?? target.baseRef, target.headRef);
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
  const conventions = await readRepoConventions(workDir);

  let sessionId = '';
  let resultText = '';
  let costUsd: number | null = null;
  let model = '';
  let usage: TokenUsage | null = null;

  const runQuery = async (): Promise<void> => {
  throwIfCancelled(opts.signal);
  sessionId = '';
  resultText = '';
  costUsd = null;
  model = '';
  usage = null;
  const stream = query({
    prompt: reviewPrompt(diff, opts, projectInstructions, conventions),
    options: {
      abortController: queryAbort(opts.signal),
      cwd: workDir,
      // The user's own Claude Code settings apply (default model, env), so a
      // review runs on the same model the CLI would. The reviewed repo's
      // .claude/settings.json is deliberately not loaded: it can carry hooks,
      // and a review must not run code from the branch under review.
      settingSources: ['user'],
      systemPrompt: SYSTEM_PROMPT,
      allowedTools: READ_ONLY_TOOLS,
      disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'],
      maxTurns: 60,
      ...(opts.model ? { model: opts.model } : {}),
      // Packaged app: the SDK's bundled CLI binary sits inside the asar; use the unpacked copy.
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
    // A cancelled query ends however the SDK ends it — report the cancel, not
    // the symptom.
    if (opts.signal?.aborted) throw new ReviewCancelledError();
    // Some models' CLI sessions exit non-zero after already delivering the
    // result — don't discard a completed review over a shutdown error.
    if (!resultText) throw err;
  }
  };

  try {
    await runQuery();
  } catch (err) {
    // One automatic retry for server-side blips; caller mistakes (auth, bad
    // ref, empty diff), cancels and repeated failures stay immediate.
    if (opts.signal?.aborted || !TRANSIENT_API_ERROR.test(String(err))) throw err;
    events.onProgress?.('[review] transient API error — retrying once in 5s…');
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await runQuery();
  }

  const parsed = parseReviewOutput(resultText);
  return {
    sessionId,
    target,
    findings: parsed.findings,
    changeSummary: parsed.changeSummary,
    model,
    headSha,
    incremental: !!sinceSha,
    usage,
    costUsd,
    durationMs: Date.now() - started,
    workDir,
  };
}

export function summarizeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    return String(o.file_path ?? o.pattern ?? o.path ?? '');
  }
  return '';
}

/**
 * Find the first {...} span in `text` that parses and satisfies `accept`.
 * The agent is told to emit bare JSON, but its message may contain stray
 * braces in surrounding prose (e.g. inline "{type: 'percent'}" examples), so
 * candidate spans are tried until one matches the expected shape.
 */
export function scanForJson<T>(text: string, accept: (parsed: T) => boolean): T | null {
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
        const parsed = JSON.parse(text.slice(start, end + 1)) as T;
        if (accept(parsed)) return parsed;
      } catch {
        // keep scanning
      }
    }
  }
  return null;
}

export function parseReviewOutput(text: string): { changeSummary: string; findings: Finding[] } {
  const parsed = scanForJson<{ changeSummary?: string; findings?: Finding[] }>(
    text,
    (o) => o.changeSummary !== undefined || Array.isArray(o.findings),
  );
  if (!parsed) throw new Error(`Review output contained no parseable review JSON:\n${text}`);
  return { changeSummary: parsed.changeSummary ?? '', findings: parsed.findings ?? [] };
}
