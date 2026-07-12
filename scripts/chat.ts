/**
 * Continue the last review session with a question.
 *
 *   npm run chat -- "Why is finding 1 a bug? Isn't it guarded by the null check above?"
 */
import { readFile, writeFile } from 'node:fs/promises';
import { chat } from '../src/engine/chat.js';
import type { ReviewResult } from '../src/engine/types.js';

const message = process.argv.slice(2).join(' ').trim();
if (!message) {
  console.error('Usage: npm run chat -- "<question about the last review>"');
  process.exit(1);
}

const stateUrl = new URL('../.margin/last-review.json', import.meta.url);
const review = JSON.parse(await readFile(stateUrl, 'utf8')) as ReviewResult;

console.error(`Resuming session ${review.sessionId} ...\n`);
const reply = await chat(review.sessionId, review.workDir, message);
console.log(reply.text);

review.sessionId = reply.sessionId;
await writeFile(stateUrl, JSON.stringify(review, null, 2));
