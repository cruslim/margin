import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  collectReplies,
  formatInboxItem,
  itemId,
  outboxFile,
  parseItemId,
  submitTurn,
  withdrawTurn,
  type InboxContext,
} from './bridge.js';

const COMMENT = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

const ctx = (over: Partial<InboxContext> = {}): InboxContext => ({
  repoPath: '/Users/dev/work/margin',
  baseRef: 'master',
  headRef: 'feat/themes',
  file: 'src/main/index.ts',
  side: 'new',
  startLine: 261,
  endLine: 264,
  quoted: 'const win = createWindow(themeBg);',
  messages: [{ role: 'user', text: 'why is this not cancellable?', at: 1 }],
  ...over,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'margin-bridge-test-'));
});

/** Far enough ahead that everything written during the test counts as settled. */
const settled = () => Date.now() + 10_000;

describe('parseItemId', () => {
  it('round-trips an item id', () => {
    expect(parseItemId(`${itemId(COMMENT, 3)}.md`)).toEqual({ threadId: COMMENT, turn: 3 });
  });

  it('keeps the single dashes of a UUID intact', () => {
    expect(parseItemId(`${itemId(COMMENT, 0)}.md`)?.threadId).toBe(COMMENT);
  });

  it('rejects names that are not items', () => {
    expect(parseItemId('README.md')).toBeNull();
    expect(parseItemId(`${COMMENT}.md`)).toBeNull();
    expect(parseItemId(`${COMMENT}--notanumber.md`)).toBeNull();
    expect(parseItemId('--2.md')).toBeNull();
  });
});

describe('formatInboxItem', () => {
  const item = itemId(COMMENT, 1);
  const body = formatInboxItem(item, ctx(), '/reply/here.md');

  it('front-matters everything needed to locate the code and reply', () => {
    expect(body).toContain(`id: "${item}"`);
    expect(body).toContain(`thread: "${COMMENT}"`);
    expect(body).toContain('kind: comment');
    expect(body).toContain('repo: "/Users/dev/work/margin"');
    expect(body).toContain('review: "master...feat/themes"');
    expect(body).toContain('lines: "261-264"');
    expect(body).toContain('reply_to: "/reply/here.md"');
  });

  it('includes the quoted source and the thread', () => {
    expect(body).toContain('const win = createWindow(themeBg);');
    expect(body).toContain('**Reviewer:** why is this not cancellable?');
  });

  it('labels earlier assistant messages as earlier replies', () => {
    const withHistory = formatInboxItem(
      item,
      ctx({
        messages: [
          { role: 'user', text: 'first ask', at: 1 },
          { role: 'assistant', text: 'done that', at: 2 },
          { role: 'user', text: 'now this', at: 3 },
        ],
      }),
      '/reply/here.md',
    );
    expect(withHistory).toContain('**Earlier reply:** done that');
    expect(withHistory).toContain('**Reviewer:** now this');
  });

  it('names the working tree when there is no head ref', () => {
    expect(formatInboxItem(item, ctx({ headRef: null }), '/r.md')).toContain('review: "master...working tree"');
  });

  it('collapses a single-line range', () => {
    expect(formatInboxItem(item, ctx({ startLine: 42, endLine: 42 }), '/r.md')).toContain('lines: "42"');
  });

  it('quotes values so a path containing a colon cannot break the front matter', () => {
    expect(formatInboxItem(item, ctx({ file: 'src/weird: name.ts' }), '/r.md')).toContain('file: "src/weird: name.ts"');
  });
});

describe('formatInboxItem for a finding', () => {
  const item = itemId('f-1a2b3c4d', 0);
  const asFinding = formatInboxItem(
    item,
    ctx({
      messages: [],
      finding: { severity: 'high', category: 'correctness', summary: 'Off-by-one skips the last item.', failure: 'Checkout with 3 items charges for 2.' },
    }),
    '/reply/here.md',
  );

  it('is tagged as a finding, with its severity and category', () => {
    expect(asFinding).toContain('kind: finding');
    expect(asFinding).toContain('severity: "high"');
    expect(asFinding).toContain('category: "correctness"');
    expect(asFinding).toContain('# Margin review finding in src/main/index.ts');
  });

  it('states the diagnosis, so the agent can act without it being restated', () => {
    expect(asFinding).toContain('**high · correctness** — Off-by-one skips the last item.');
    expect(asFinding).toContain('How it fails: Checkout with 3 items charges for 2.');
  });

  it('says so when handed over with no conversation', () => {
    expect(asFinding).toContain('handed this over without further comment');
    expect(asFinding).not.toContain('## Thread');
  });

  it('still carries a conversation when there is one', () => {
    const withThread = formatInboxItem(
      item,
      ctx({
        messages: [{ role: 'user', text: 'is this actually reachable?', at: 1 }],
        finding: { severity: 'low', category: 'style', summary: 'Naming.' },
      }),
      '/r.md',
    );
    expect(withThread).toContain('## Thread');
    expect(withThread).toContain('**Reviewer:** is this actually reachable?');
    expect(withThread).not.toContain('handed this over without further comment');
  });

  it('invites disagreement rather than assuming the finding is right', () => {
    expect(asFinding).toContain('If you disagree, say so instead of changing code');
  });
});

describe('submitTurn', () => {
  it('writes the request and the protocol note', async () => {
    const item = itemId(COMMENT, 1);
    await submitTurn(dir, item, ctx());
    expect(await readdir(dir)).toEqual(expect.arrayContaining(['README.md', 'inbox', 'outbox', 'processed']));
    expect(await readdir(join(dir, 'inbox'))).toEqual([`${item}.md`]);
  });
});

describe('collectReplies', () => {
  const item = itemId(COMMENT, 1);

  it('delivers a reply and retires both halves of the exchange', async () => {
    await submitTurn(dir, item, ctx());
    await writeFile(outboxFile(dir, item), 'Added the guard on line 262.\n');

    expect(await collectReplies(dir, settled())).toEqual([
      { threadId: COMMENT, turn: 1, text: 'Added the guard on line 262.' },
    ]);
    expect(await readdir(join(dir, 'inbox'))).toEqual([]);
    expect(await readdir(join(dir, 'outbox'))).toEqual([]);
    expect((await readdir(join(dir, 'processed'))).sort()).toEqual([`${item}.reply.md`, `${item}.request.md`]);
  });

  it('delivers each turn exactly once', async () => {
    await submitTurn(dir, item, ctx());
    await writeFile(outboxFile(dir, item), 'done');
    expect(await collectReplies(dir, settled())).toHaveLength(1);
    expect(await collectReplies(dir, settled())).toEqual([]);
  });

  it('leaves a reply still being written for the next tick', async () => {
    await submitTurn(dir, item, ctx());
    await writeFile(outboxFile(dir, item), 'half a rep');

    expect(await collectReplies(dir, Date.now())).toEqual([]);
    expect(await readdir(join(dir, 'inbox'))).toEqual([`${item}.md`]);
    expect(await collectReplies(dir, settled())).toHaveLength(1);
  });

  it('ignores an empty file and files that are not items', async () => {
    await submitTurn(dir, item, ctx());
    await writeFile(outboxFile(dir, item), '  \n');
    await writeFile(join(dir, 'outbox', 'notes.txt'), 'scratch');
    await writeFile(join(dir, 'outbox', 'README.md'), 'hello');

    expect(await collectReplies(dir, settled())).toEqual([]);
    expect(await readdir(join(dir, 'inbox'))).toEqual([`${item}.md`]);
  });

  it('routes replies to their own threads, oldest turn of a thread first', async () => {
    const other = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await submitTurn(dir, itemId(COMMENT, 3), ctx());
    await submitTurn(dir, itemId(COMMENT, 1), ctx());
    await submitTurn(dir, itemId(other, 1), ctx());
    await writeFile(outboxFile(dir, itemId(COMMENT, 3)), 'third');
    await writeFile(outboxFile(dir, itemId(COMMENT, 1)), 'first');
    await writeFile(outboxFile(dir, itemId(other, 1)), 'other thread');

    const replies = await collectReplies(dir, settled());
    expect(replies).toHaveLength(3);
    // Ordering that matters is within a thread — an out-of-order pair would
    // append the answers to the wrong questions.
    expect(replies.filter((r) => r.threadId === COMMENT)).toEqual([
      { threadId: COMMENT, turn: 1, text: 'first' },
      { threadId: COMMENT, turn: 3, text: 'third' },
    ]);
    expect(replies).toContainEqual({ threadId: other, turn: 1, text: 'other thread' });
  });

  it('is empty for a bridge that was never used', async () => {
    expect(await collectReplies(join(dir, 'nope'), settled())).toEqual([]);
  });
});

describe('withdrawTurn', () => {
  it('takes the request off the agent’s work list but keeps the record', async () => {
    const item = itemId(COMMENT, 1);
    await submitTurn(dir, item, ctx());
    await withdrawTurn(dir, item);

    expect(await readdir(join(dir, 'inbox'))).toEqual([]);
    expect(await readdir(join(dir, 'processed'))).toEqual([`${item}.request.md`]);
  });

  it('is quiet when there is nothing to withdraw', async () => {
    await expect(withdrawTurn(dir, itemId(COMMENT, 9))).resolves.toBeUndefined();
  });
});
