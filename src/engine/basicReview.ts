import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generatedFilesNote } from '../shared/generated.js';
import { mergeInstructions, readRepoInstructionsFile } from './instructions.js';
import type { Finding, ReviewOptions, ReviewTarget } from './types.js';
import { parseReviewOutput } from './review.js';
import { branchDiff, createWorktree, removeWorktree, workingTreeDiff, changedPaths, usableSinceSha } from './worktree.js';

export interface BasicProvider {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const MAX_FILES = 20;
const MAX_FILE_CHARS = 25_000;
const MAX_TOTAL_CHARS = 120_000;

// Ollama's OpenAI-compatible layer ignores context-size options and its
// server default is far below a review prompt, so the runtime context-shifts
// the top of the diff out of view without any error. When the endpoint is
// Ollama, we use its native chat API instead, sizing num_ctx to the prompt.
const OLLAMA_CHARS_PER_TOKEN = 3.2; // safe lower bound for code-heavy text
const OLLAMA_OUTPUT_HEADROOM = 8_192;
const OLLAMA_MIN_CTX = 16_384;
const OLLAMA_MAX_CTX = 65_536; // KV-cache guardrail for local machines

export function ollamaNumCtx(promptChars: number): number {
  const estimate = Math.ceil(promptChars / OLLAMA_CHARS_PER_TOKEN) + OLLAMA_OUTPUT_HEADROOM;
  return Math.min(OLLAMA_MAX_CTX, Math.max(OLLAMA_MIN_CTX, estimate));
}

/** Returns the server origin if baseUrl fronts an Ollama server, else null. */
export async function detectOllama(baseUrl: string): Promise<string | null> {
  try {
    const origin = new URL(baseUrl).origin;
    const res = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === 'string' ? origin : null;
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = `You are a code reviewer. You are given a diff and the full contents of the changed files. You cannot explore the repository further, so only report defects you can see evidence for in the provided code.

Rules:
- Only report defects a reviewer would block a merge for: incorrect behaviour, security issues, data loss, unhandled errors, real performance problems. No style nits.
- Every finding must name a concrete failure scenario: what input or state triggers it and what goes wrong.
- Findings must anchor to a line in the NEW version of a changed file, and include the exact source snippet at that line.`;

function outputInstructions(): string {
  return `Output ONLY a JSON object (no prose before or after, no code fence) with this shape:
{
  "changeSummary": "<one paragraph>",
  "findings": [
    {
      "file": "<repo-relative path>",
      "line": <1-indexed line in the new file version>,
      "severity": "critical" | "high" | "medium" | "low",
      "category": "correctness" | "security" | "performance" | "error-handling" | "test-coverage" | "other",
      "summary": "<one sentence>",
      "failureScenario": "<concrete inputs/state -> wrong outcome>",
      "snippet": "<exact source line(s)>"
    }
  ]
}
An empty findings array is a valid result.`;
}

/**
 * Single-shot review against any OpenAI-compatible endpoint (OpenAI, Ollama,
 * OpenRouter…). No repo exploration — the diff plus changed-file contents go
 * in one request. A different model family = an independent perspective;
 * the agentic verifier can cross-examine whatever this reports.
 *
 * Ollama servers are detected automatically and spoken to over their native
 * chat API so the context window can be sized per request (see ollamaNumCtx).
 */
export async function runBasicReview(
  target: ReviewTarget,
  provider: BasicProvider,
  opts: ReviewOptions = {},
  onProgress?: (line: string) => void,
): Promise<{ findings: Finding[]; model: string }> {
  const tag = provider.model;
  onProgress?.(`[${tag}] gathering context`);

  let diff: string;
  let workDir: string;
  let ownWorktree = false;
  // Same rebase guard as the agentic review — silently here, since that one
  // already puts the explanation in the transcript.
  const sinceSha = target.headRef
    ? await usableSinceSha(target.repoPath, opts.sinceSha, target.headRef)
    : undefined;
  if (target.headRef) {
    diff = await branchDiff(target.repoPath, sinceSha ?? target.baseRef, target.headRef);
    workDir = await createWorktree(target.repoPath, target.headRef);
    ownWorktree = true;
  } else {
    diff = await workingTreeDiff(target.repoPath);
    workDir = target.repoPath;
  }

  try {
    if (!diff.trim()) return { findings: [], model: tag };

    const paths = (await changedPaths(target.repoPath, sinceSha ?? target.baseRef, target.headRef)).slice(0, MAX_FILES);
    let total = 0;
    const fileSections: string[] = [];
    for (const p of paths) {
      if (total >= MAX_TOTAL_CHARS) break;
      const content = await readFile(join(workDir, p), 'utf8').catch(() => '');
      if (!content || content.includes('\0')) continue;
      const clipped = content.slice(0, MAX_FILE_CHARS);
      total += clipped.length;
      fileSections.push(`--- ${p} ---\n${clipped}`);
    }

    const projectInstructions = mergeInstructions(opts.instructions, await readRepoInstructionsFile(workDir));
    let preamble = '';
    if (projectInstructions.trim()) {
      preamble += `Project-specific review instructions (follow these):\n${projectInstructions.trim()}\n\n`;
    }
    if (opts.dismissed?.length) {
      preamble +=
        'Previously dismissed findings — do NOT report these or trivial variations:\n' +
        opts.dismissed.map((d) => `- ${d.file} [${d.category}]: ${d.summary}`).join('\n') +
        '\n\n';
    }
    preamble += generatedFilesNote(diff);

    const user = `${preamble}${outputInstructions()}

DIFF:
\`\`\`diff
${diff}
\`\`\`

FULL CONTENTS OF CHANGED FILES (new versions):
${fileSections.join('\n\n')}`;

    type Msg = { role: string; content: string };

    const ollamaOrigin = await detectOllama(provider.baseUrl);
    const numCtx = ollamaNumCtx(SYSTEM_PROMPT.length + user.length);
    if (ollamaOrigin) {
      onProgress?.(`[${tag}] ollama endpoint — requesting a ${numCtx}-token context`);
      if (numCtx === OLLAMA_MAX_CTX) {
        onProgress?.(`[${tag}] prompt may exceed the ${OLLAMA_MAX_CTX}-token cap — start of the diff could be dropped`);
      }
    }

    const requestOllama = async (messages: Msg[], jsonMode: boolean): Promise<string> => {
      const res = await fetch(`${ollamaOrigin}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: provider.model,
          messages,
          stream: false,
          ...(jsonMode ? { format: 'json' } : {}),
          options: { num_ctx: numCtx },
        }),
        // A hung endpoint must fail the finder, not pin the whole review.
        signal: AbortSignal.timeout(5 * 60_000),
      }).catch((err: unknown) => {
        if ((err as Error).name === 'TimeoutError') {
          throw new Error(`${provider.model} endpoint produced no response for 5 minutes — gave up`);
        }
        throw err;
      });
      if (!res.ok) throw new Error(`${tag}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      const data = (await res.json()) as { message?: { content?: string } };
      return data.message?.content ?? '';
    };

    const requestOpenAi = async (messages: Msg[], jsonMode: boolean): Promise<string> => {
      const res = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: provider.model,
          messages,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
        // A hung endpoint must fail the finder, not pin the whole review.
        signal: AbortSignal.timeout(5 * 60_000),
      }).catch((err: unknown) => {
        if ((err as Error).name === 'TimeoutError') {
          throw new Error(`${provider.model} endpoint produced no response for 5 minutes — gave up`);
        }
        throw err;
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        // Some OpenAI-compatible servers reject response_format — retry without.
        if (jsonMode && res.status === 400) return requestOpenAi(messages, false);
        throw new Error(`${tag}: HTTP ${res.status} ${body}`);
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? '';
    };

    const request = ollamaOrigin ? requestOllama : requestOpenAi;

    const messages: Msg[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ];
    onProgress?.(`[${tag}] requesting review`);
    const content = await request(messages, true);
    let parsed;
    try {
      parsed = parseReviewOutput(content);
    } catch {
      // Small models sometimes answer in prose despite JSON mode — one corrective retry.
      onProgress?.(`[${tag}] reply was not JSON, retrying once`);
      const retry = await request(
        [
          ...messages,
          { role: 'assistant', content },
          {
            role: 'user',
            content:
              'Your previous reply was not the required JSON. Reply with ONLY the JSON object in the exact shape described earlier — no prose, no code fences.',
          },
        ],
        true,
      );
      parsed = parseReviewOutput(retry);
    }
    onProgress?.(`[${tag}] ${parsed.findings.length} finding(s)`);
    return { findings: parsed.findings.map((f) => ({ ...f, source: tag })), model: tag };
  } finally {
    if (ownWorktree) await removeWorktree(target.repoPath, workDir);
  }
}
