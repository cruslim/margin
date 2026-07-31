import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatMessage } from '../shared/ipc.js';

/**
 * The file bridge behind external agent mode: Margin writes one file per
 * brokered comment turn, an external agent (Claude Code, a CI job, a colleague)
 * writes the reply back. One writer per file, so neither side can clobber the
 * other — and `inbox/` always holds exactly the outstanding requests.
 *
 *   <bridge>/inbox/<item>.md      Margin writes — an unanswered request
 *   <bridge>/outbox/<item>.md     the agent writes — same basename
 *   <bridge>/processed/           both sides, once the reply is delivered
 *
 * Everything here takes the bridge directory as an argument: resolving it needs
 * electron's userData path, which lives in storage.ts, and keeping this module
 * free of that keeps it testable.
 */

/** An outbox file is only read once it has been still this long — a reply mid-write is half a reply. */
const SETTLE_MS = 500;

/** Reply to one brokered turn, routed back to its thread by comment id. */
export interface BridgeReply {
  commentId: string;
  turn: number;
  text: string;
}

/** Everything the external agent needs to act on one comment turn. */
export interface InboxContext {
  repoPath: string;
  baseRef: string;
  headRef: string | null;
  file: string;
  side: 'old' | 'new';
  startLine: number;
  endLine: number;
  quoted?: string;
  /** The thread so far, oldest first — the new user message is the last one. */
  messages: ChatMessage[];
}

/**
 * Item id for a turn: the comment it belongs to plus how many messages preceded
 * it. Unique per turn (a thread brokers a new request on every reply) and
 * sortable. UUIDs contain single dashes only, so `--` separates unambiguously.
 */
export function itemId(commentId: string, turn: number): string {
  return `${commentId}--${turn}`;
}

export function parseItemId(fileName: string): { commentId: string; turn: number } | null {
  const base = fileName.replace(/\.md$/, '');
  const at = base.lastIndexOf('--');
  if (at <= 0) return null;
  const turn = Number(base.slice(at + 2));
  if (!Number.isInteger(turn) || turn < 0) return null;
  return { commentId: base.slice(0, at), turn };
}

function inboxFile(dir: string, item: string): string {
  return join(dir, 'inbox', `${item}.md`);
}

export function outboxFile(dir: string, item: string): string {
  return join(dir, 'outbox', `${item}.md`);
}

/** Double-quoted so a path or ref containing `: ` can't break the front matter. */
function quoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function lineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? String(endLine) : `${startLine}-${endLine}`;
}

/** The file Margin drops in `inbox/` — front matter for machines, the rest for whoever reads it. */
export function formatInboxItem(item: string, ctx: InboxContext, replyPath: string): string {
  const parsed = parseItemId(item);
  const range = lineRange(ctx.startLine, ctx.endLine);
  const thread = ctx.messages
    .map((m) => `**${m.role === 'user' ? 'Reviewer' : 'Earlier reply'}:** ${m.text.trim()}`)
    .join('\n\n');

  return `---
id: ${quoted(item)}
comment: ${quoted(parsed?.commentId ?? item)}
repo: ${quoted(ctx.repoPath)}
review: ${quoted(`${ctx.baseRef}...${ctx.headRef ?? 'working tree'}`)}
file: ${quoted(ctx.file)}
side: ${ctx.side}
lines: ${quoted(range)}
reply_to: ${quoted(replyPath)}
---

# Margin comment on ${ctx.file}:${range}

Reviewing ${ctx.baseRef}...${ctx.headRef ?? 'the working tree'} in ${ctx.repoPath}.
${ctx.side === 'old' ? 'These lines are on the old (removed) side of the diff.' : ''}
${
  ctx.quoted
    ? `## The lines under discussion

\`\`\`
${ctx.quoted}
\`\`\`
`
    : ''
}
## Thread

${thread}

## How to reply

If the comment asks for a change, make it in the repo above — that is the point of this
exchange; the reviewer sees it in the diff on refresh. Then write your reply as plain
markdown (a couple of sentences is plenty) to:

    ${replyPath}

Write that file in a single write, and only once. Margin appends its text to the thread as
the reply, then moves both files to \`processed/\`. Anything still in \`inbox/\` is
unanswered; nothing else in this directory is read, so don't edit this file.
`;
}

const PROTOCOL_README = `# Margin agent bridge

Margin is brokering its comment threads to you. This directory is the whole protocol.

- \`inbox/<item>.md\` — an unanswered comment from the reviewer. Each file names the repo,
  the file and lines it is about, the thread so far, and the exact path to reply to.
- \`outbox/<item>.md\` — your reply. Same basename as the inbox file it answers; plain
  markdown, written in one shot.
- \`processed/\` — where Margin moves both halves once a reply is delivered
  (\`<item>.request.md\` and \`<item>.reply.md\`). Read-only history.

Loop: read everything in \`inbox/\`, make the changes the comments ask for in the repo, and
write one \`outbox/\` file per item. Margin polls every second or so, appends your text to
the thread, and clears the item out of \`inbox/\`.

This is ongoing, not a one-off. The reviewer is reading the diff while you work, so new
items land in \`inbox/\` at any time — come back and check it again after you finish a
batch, rather than assuming an empty inbox means the review is over.

Only Margin writes \`inbox/\`; only you write \`outbox/\`. Nothing here is a shared file, so
there is nothing to conflict over.
`;

export async function ensureBridge(dir: string): Promise<string> {
  await Promise.all([
    mkdir(join(dir, 'inbox'), { recursive: true }),
    mkdir(join(dir, 'outbox'), { recursive: true }),
    mkdir(join(dir, 'processed'), { recursive: true }),
  ]);
  // Rewritten every time rather than only when missing, so the protocol note
  // never describes an older build.
  await writeFile(join(dir, 'README.md'), PROTOCOL_README);
  return dir;
}

/** Broker one turn: the inbox file is the request, and its presence is the pending state. */
export async function submitTurn(dir: string, item: string, ctx: InboxContext): Promise<string> {
  await ensureBridge(dir);
  const replyPath = outboxFile(dir, item);
  await writeFile(inboxFile(dir, item), formatInboxItem(item, ctx, replyPath));
  return inboxFile(dir, item);
}

/**
 * Stop waiting on a turn. The request moves to `processed/` rather than being
 * deleted — it still happened — and leaving `inbox/` clears it from the agent's
 * work list.
 */
export async function withdrawTurn(dir: string, item: string): Promise<void> {
  await mkdir(join(dir, 'processed'), { recursive: true });
  await rename(inboxFile(dir, item), join(dir, 'processed', `${item}.request.md`)).catch(() => {});
}

/**
 * Drain `outbox/`. Each reply retires its request from `inbox/`, so a turn is
 * delivered exactly once — including replies written while Margin wasn't running.
 */
export async function collectReplies(dir: string, now = Date.now()): Promise<BridgeReply[]> {
  const names = await readdir(join(dir, 'outbox')).catch(() => [] as string[]);
  const replies: BridgeReply[] = [];

  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const parsed = parseItemId(name);
    if (!parsed) continue;
    const path = join(dir, 'outbox', name);

    // A file still being written is left for the next tick rather than read half-done.
    const info = await stat(path).catch(() => null);
    if (!info || now - info.mtimeMs < SETTLE_MS) continue;

    const text = await readFile(path, 'utf8').catch(() => '');
    if (!text.trim()) continue;

    const item = name.replace(/\.md$/, '');
    await mkdir(join(dir, 'processed'), { recursive: true });
    await rename(path, join(dir, 'processed', `${item}.reply.md`));
    await rename(inboxFile(dir, item), join(dir, 'processed', `${item}.request.md`)).catch(() => {});
    replies.push({ ...parsed, text: text.trim() });
  }

  // Oldest turn first, so a thread that got several replies at once reads in order.
  return replies.sort((a, b) => a.turn - b.turn);
}
