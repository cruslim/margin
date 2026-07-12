/**
 * Milestone 1 spike CLI.
 *
 *   npm run review -- <repoPath> --base main --head my-branch
 *   npm run review -- <repoPath> --working          # uncommitted changes vs HEAD
 *
 * Prints findings and saves the session (id + workDir) to .margin/last-review.json
 * so `npm run chat` can continue the conversation.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runReview } from '../src/engine/review.js';

const args = process.argv.slice(2);
const repoPath = args.find((a) => !a.startsWith('--'));
if (!repoPath) {
  console.error('Usage: npm run review -- <repoPath> [--base <ref>] [--head <ref>] [--working]');
  process.exit(1);
}

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

const target = {
  repoPath: resolve(repoPath),
  baseRef: flag('base') ?? 'main',
  headRef: args.includes('--working') ? null : flag('head') ?? null,
};

if (!target.headRef && !args.includes('--working')) {
  console.error('Specify --head <ref> or --working');
  process.exit(1);
}

console.error(`Reviewing ${target.headRef ?? 'working tree'} in ${target.repoPath} ...\n`);

const result = await runReview(target, {
  onProgress: (line) => console.error(`  ${line}`),
});

console.error(
  `\nDone in ${(result.durationMs / 1000).toFixed(1)}s` +
    (result.costUsd != null ? ` ($${result.costUsd.toFixed(4)})` : '') +
    ` — session ${result.sessionId}\n`,
);

console.log(JSON.stringify(result, null, 2));

await mkdir(new URL('../.margin', import.meta.url), { recursive: true });
await writeFile(
  new URL('../.margin/last-review.json', import.meta.url),
  JSON.stringify(result, null, 2),
);
