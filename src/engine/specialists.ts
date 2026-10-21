import { query } from '@anthropic-ai/claude-agent-sdk';
import { generatedFilesNote } from '../shared/generated.js';
import { conventionsPreamble, mergeInstructions, readRepoConventions, readRepoInstructionsFile } from './instructions.js';
import type { AgentConfig } from './agents.js';
import { queryAbort, ReviewCancelledError, throwIfCancelled } from './types.js';
import type { Finding, ReviewOptions, ReviewTarget, RubricCheckResult, SpecialistReport } from './types.js';
import { scanForJson, summarizeInput, TRANSIENT_API_ERROR } from './review.js';
import { branchDiff, createWorktree, removeWorktree, usableSinceSha, workingTreeDiff } from './worktree.js';

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
const SPECIALIST_MODELS = new Set(['sonnet', 'opus', 'haiku']);

/** Rubric is stored as a textarea string; one non-empty line = one named check. */
export function rubricChecks(rubric: string | undefined): string[] {
  return (rubric ?? '')
    .split('\n')
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .filter(Boolean);
}

export function specialistSystemPrompt(agent: AgentConfig): string {
  return `You are "${agent.name.trim()}", a specialist code reviewer running as one finder in a review pipeline. You review a diff inside a checkout of the repository, strictly through your specialty's lens — other reviewers cover everything else.

Your specialty:
${agent.instructions.trim()}

Rules:
- First decide whether this changeset touches your specialty at all. If it does not, say so and stop — do not stretch your lens over unrelated code.
- Only report defects a reviewer would block a merge for. No style nits, no subjective preferences.
- Before reporting a finding, verify it: read the surrounding file, grep for callers or existing guards that might already handle the case. Discard anything the codebase already accounts for.
- Follow every value the change newly takes from outside the program — a URL or query parameter, a request body, header or cookie, storage, a file, the environment — to each place it is consumed, across language and process boundaries. Ask what an unexpected, extreme or hostile value does there.
- Code the diff did not touch is in scope when the change makes it newly reachable, or reachable with such a value. "Pre-existing" only excuses a problem the change neither exposes nor worsens.
- Every finding must name a concrete failure scenario: what input or state triggers it and what goes wrong.
- Findings must anchor to a line in the NEW version of a changed file, and include the exact source snippet at that line.
- For every rubric check, ground your note in what you actually read — name the mechanism, not a restatement of the check.`;
}

export function specialistPrompt(
  checks: string[],
  diff: string,
  opts: ReviewOptions,
  projectInstructions: string,
  conventions = '',
): string {
  let preamble = conventionsPreamble(conventions);
  if (opts.sinceSha) {
    preamble +=
      'This is an INCREMENTAL review: the diff below contains only changes made since the previous review of this branch. Review just these new changes.\n\n';
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

  const rubricSection = checks.length
    ? `Work through this rubric — every check must appear exactly once in your output's "checks", in order:
${checks.map((c) => `- ${c}`).join('\n')}\n\n`
    : '';

  return `${preamble}Review the following diff through your specialty's lens. Explore the repository (Read/Grep/Glob) as needed to verify each suspicion before reporting it.

${rubricSection}When you are done, output ONLY a JSON object (no prose before or after, no code fence) with this shape:
{
  "ran": <true, or false if this changeset does not touch your specialty>,
  "reason": "<one line: why the changeset is in scope for your specialty — or why it isn't>",
  "checks": [
    {
      "check": "<the rubric item, verbatim>",
      "status": "pass" | "finding" | "unclear",
      "note": "<one line of evidence from the code: what you read that satisfies or fails the check>"
    }
  ],
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
Use status "finding" only when you also report a corresponding finding. If ran is false, checks and findings must be empty arrays. An empty findings array with all-pass checks is a valid and common result.

DIFF:
\`\`\`diff
${diff}
\`\`\``;
}

interface SpecialistOutput {
  ran?: boolean;
  reason?: string;
  checks?: RubricCheckResult[];
  findings?: Finding[];
}

const CHECK_STATUSES = new Set(['pass', 'finding', 'unclear']);

/**
 * Parse the specialist's JSON and normalize it: findings are source-tagged with
 * the specialist's name, and malformed check rows are dropped rather than
 * failing the whole report.
 */
export function parseSpecialistOutput(
  text: string,
  agentName: string,
): { report: Omit<SpecialistReport, 'costUsd'>; findings: Finding[] } {
  const parsed = scanForJson<SpecialistOutput>(
    text,
    (o) => typeof o.ran === 'boolean' || Array.isArray(o.checks) || Array.isArray(o.findings),
  );
  if (!parsed) throw new Error(`Specialist output contained no parseable JSON:\n${text}`);
  const ran = parsed.ran !== false;
  const checks = ran
    ? (parsed.checks ?? []).filter(
        (c) => c && typeof c.check === 'string' && CHECK_STATUSES.has(c.status),
      )
    : [];
  const findings = ran
    ? (parsed.findings ?? []).map((f) => ({ ...f, source: agentName }))
    : [];
  return {
    report: { agent: agentName, ran, reason: (parsed.reason ?? '').trim(), checks },
    findings,
  };
}

/**
 * Run one configured specialist as a finder: an agentic session over its own
 * temp worktree, same read-only sandbox as the main reviewer, findings tagged
 * with the specialist's name so the UI and the verifier treat them like any
 * other finder's. Returns a report even when the specialist judged the
 * changeset out of scope — the skip and its reason are worth showing.
 */
export async function runSpecialistReview(
  target: ReviewTarget,
  agent: AgentConfig,
  opts: ReviewOptions = {},
  onProgress?: (line: string) => void,
): Promise<{ findings: Finding[]; report: SpecialistReport }> {
  const name = agent.name.trim();
  const tag = `@${name}`;
  onProgress?.(`[${tag}] starting specialist pass`);

  // Same rebase guard as the agentic review — silently here, since that one
  // already puts the explanation in the transcript.
  const sinceSha = target.headRef
    ? await usableSinceSha(target.repoPath, opts.sinceSha, target.headRef)
    : undefined;

  let diff: string;
  let workDir: string;
  let ownWorktree = false;
  if (target.headRef) {
    diff = await branchDiff(target.repoPath, sinceSha ?? target.baseRef, target.headRef);
    workDir = await createWorktree(target.repoPath, target.headRef);
    ownWorktree = true;
  } else {
    diff = await workingTreeDiff(target.repoPath);
    workDir = target.repoPath;
  }

  try {
    if (!diff.trim()) {
      return {
        findings: [],
        report: { agent: name, ran: false, reason: 'Diff is empty.', checks: [], costUsd: null },
      };
    }

    const projectInstructions = mergeInstructions(opts.instructions, await readRepoInstructionsFile(workDir));
    const conventions = await readRepoConventions(workDir);
    const checks = rubricChecks(agent.rubric);
    // The specialist's own model tier wins over the session choice, matching
    // how these agents behave when delegated a comment thread.
    const model = agent.model && SPECIALIST_MODELS.has(agent.model) ? agent.model : opts.model;

    let resultText = '';
    let costUsd: number | null = null;

    const runQuery = async (): Promise<void> => {
      throwIfCancelled(opts.signal);
      resultText = '';
      costUsd = null;
      const stream = query({
        prompt: specialistPrompt(checks, diff, { ...opts, sinceSha }, projectInstructions, conventions),
        options: {
          abortController: queryAbort(opts.signal),
          cwd: workDir,
          // User settings only — see review.ts.
          settingSources: ['user'],
          systemPrompt: specialistSystemPrompt(agent),
          allowedTools: READ_ONLY_TOOLS,
          disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'],
          maxTurns: 40,
          ...(model ? { model } : {}),
          // Packaged app: the SDK's bundled CLI binary sits inside the asar; use the unpacked copy.
          ...(process.env.MARGIN_CLI_PATH ? { pathToClaudeCodeExecutable: process.env.MARGIN_CLI_PATH } : {}),
        },
      });

      try {
        for await (const message of stream) {
          if (message.type === 'assistant') {
            for (const block of message.message.content) {
              if (block.type === 'tool_use') {
                onProgress?.(`[${tag}] [tool] ${block.name} ${summarizeInput(block.input)}`);
              } else if (block.type === 'text' && block.text.trim()) {
                onProgress?.(`[${tag}] ${block.text.trim()}`);
              }
            }
          } else if (message.type === 'result') {
            costUsd = 'total_cost_usd' in message ? message.total_cost_usd : null;
            if (message.subtype === 'success') {
              resultText = message.result;
            } else {
              throw new Error(`Specialist session ended without a result: ${message.subtype}`);
            }
          }
        }
      } catch (err) {
        if (opts.signal?.aborted) throw new ReviewCancelledError();
        // Some models' CLI sessions exit non-zero after already delivering the
        // result — don't discard a completed pass over a shutdown error.
        if (!resultText) throw err;
      }
    };

    try {
      await runQuery();
    } catch (err) {
      if (opts.signal?.aborted || !TRANSIENT_API_ERROR.test(String(err))) throw err;
      onProgress?.(`[${tag}] transient API error — retrying once in 5s…`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await runQuery();
    }

    const { report, findings } = parseSpecialistOutput(resultText, name);
    onProgress?.(
      report.ran
        ? `[${tag}] ${report.checks.length} check(s), ${findings.length} finding(s)`
        : `[${tag}] skipped: ${report.reason}`,
    );
    return { findings, report: { ...report, costUsd } };
  } finally {
    if (ownWorktree) await removeWorktree(target.repoPath, workDir).catch(() => {});
  }
}
