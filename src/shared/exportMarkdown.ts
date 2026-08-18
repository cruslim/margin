import type { ChatMessage, Comment, Session } from './ipc.js';
import type { Finding } from '../engine/types.js';

const SEV_ORDER: Record<Finding['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };

export interface ExportOptions {
  /**
   * The UI's dismissal filter, passed in rather than recomputed here: dismissal
   * memory lives per repo in the renderer, and the export should show exactly
   * what the findings panel shows.
   */
  isDismissed?: (f: Finding) => boolean;
}

/**
 * Render a session as a standalone Markdown document — the exit ramp from a
 * local review: paste it into a PR description or hand it to a teammate.
 *
 * Scope matches what the UI presents as "the review": summary, findings (with
 * verdicts and their reply threads), refuted findings as one-liners, and
 * line-anchored comment threads. General session chat is deliberately left
 * out — it's exploration, not review record.
 */
export function sessionToMarkdown(s: Session, opts: ExportOptions = {}): string {
  const isDismissed = opts.isDismissed ?? (() => false);
  const kept = s.findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => !isDismissed(finding) && finding.verdict !== 'refuted')
    .sort((a, b) => SEV_ORDER[a.finding.severity] - SEV_ORDER[b.finding.severity]);
  const refuted = s.findings.filter((f) => f.verdict === 'refuted');

  const out: string[] = [];
  out.push(`# Margin review: ${s.repoName} — ${s.headRef ?? 'uncommitted changes'} vs ${s.baseRef}`);
  out.push(metaLine(s, kept.length));
  if (s.changeSummary) out.push(s.changeSummary.trim());

  if (kept.length > 0) {
    out.push('## Findings');
    for (const { finding, index } of kept) {
      out.push(...findingSection(finding, s.threads?.[index]));
    }
  } else {
    out.push('## Findings\n\nNone.');
  }

  if (refuted.length > 0) {
    out.push(
      `## Refuted by verifier (${refuted.length})`,
      refuted
        .map((f) => `- \`${f.file}:${f.line}\` — ${f.summary}${f.verdictReason ? ` — ${f.verdictReason}` : ''}`)
        .join('\n'),
    );
  }

  const comments = (s.comments ?? []).slice().sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
  if (comments.length > 0) {
    out.push('## Comment threads');
    for (const c of comments) out.push(...commentSection(c));
  }

  out.push('---\n*Exported from [Margin](https://github.com/cruslim/margin).*');
  return out.join('\n\n') + '\n';
}

function metaLine(s: Session, findingCount: number): string {
  const parts: string[] = [];
  if (s.createdAt) parts.push(new Date(s.createdAt).toISOString().slice(0, 10));
  if (s.model) parts.push(`model ${s.model}`);
  if (s.costUsd != null) parts.push(`$${s.costUsd.toFixed(2)}`);
  parts.push(`${findingCount} finding${findingCount === 1 ? '' : 's'}`);
  return `*${parts.join(' · ')}*`;
}

function findingSection(f: Finding, thread: ChatMessage[] | undefined): string[] {
  const out: string[] = [];
  out.push(`### \`${f.file}:${f.line}\` — ${f.summary}`);

  const badges = [`**${f.severity} · ${f.category}**`];
  if (f.source) badges.push(`found by ${f.source}`);
  if (f.verdict === 'confirmed') badges.push(`✓ verified${f.verdictReason ? ` — ${f.verdictReason}` : ''}`);
  if (f.verdict === 'uncertain') badges.push(`? unverified${f.verdictReason ? ` — ${f.verdictReason}` : ''}`);
  out.push(badges.join(' · '));

  if (f.failureScenario) out.push(f.failureScenario.trim());
  if (f.snippet) out.push(codeBlock(f.snippet, extOf(f.file)));
  if (thread && thread.length > 0) out.push(threadBlock(thread, 'Margin'));
  return out;
}

function commentSection(c: Comment): string[] {
  const out: string[] = [];
  const lines = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}–${c.endLine}`;
  out.push(`### \`${c.file}:${lines}\`${c.resolved ? ' — resolved ✓' : ''}`);
  if (c.quoted) out.push(codeBlock(c.quoted, extOf(c.file)));
  // Threads answered elsewhere say so: a specialist's name, or the user's own
  // agent over the bridge — "Margin" would misattribute those replies.
  const replier = c.agent ? `@${c.agent}` : c.external ? 'Your agent' : 'Margin';
  if (c.messages.length > 0) out.push(threadBlock(c.messages, replier));
  return out;
}

function threadBlock(messages: ChatMessage[], replier: string): string {
  return messages
    .map((m) => quote(`**${m.role === 'user' ? 'You' : replier}:** ${m.text.trim()}`))
    .join('\n>\n');
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * Fence with more backticks than any run inside the content, so a snippet that
 * itself contains ``` doesn't end the block early.
 */
function codeBlock(content: string, lang: string): string {
  const runs = content.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${fence}${lang}\n${content.replace(/\n$/, '')}\n${fence}`;
}

/** Extension as the fence's language hint; close enough for highlighting. */
function extOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1) : '';
}
