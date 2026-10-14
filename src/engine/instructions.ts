import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Repo-committed instructions file, kept under .margin/ to avoid another root dotfile. */
export const REPO_INSTRUCTIONS_FILE = '.margin/margin.md';

export async function readRepoInstructionsFile(workDir: string): Promise<string> {
  return readFile(join(workDir, REPO_INSTRUCTIONS_FILE), 'utf8').catch(() => '');
}

/**
 * The files Claude Code itself loads for a repository's conventions. A review
 * session never sees them on its own: it is not given the repo's project
 * settings (see settingSources in review.ts), and its custom system prompt
 * replaces the one that would carry them anyway. So a reviewer that should
 * hold a change to the repo's own rules has to be handed them here.
 */
export const REPO_CONVENTIONS_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];

/** Enough for a long CLAUDE.md; anything past it is cut with a note rather than crowding out the diff. */
const MAX_CONVENTIONS_CHARS = 40_000;

export async function readRepoConventions(workDir: string): Promise<string> {
  const parts: string[] = [];
  for (const file of REPO_CONVENTIONS_FILES) {
    const text = (await readFile(join(workDir, file), 'utf8').catch(() => '')).trim();
    if (text) parts.push(`--- ${file} ---\n${text}`);
  }
  const joined = parts.join('\n\n');
  return joined.length > MAX_CONVENTIONS_CHARS
    ? `${joined.slice(0, MAX_CONVENTIONS_CHARS)}\n[… truncated]`
    : joined;
}

/**
 * The conventions as a prompt block. A CLAUDE.md addresses an agent changing
 * the code — "run this skill first", "stop and refactor" — so it is framed as
 * what the change must live up to, not as orders to the reviewer.
 */
export function conventionsPreamble(conventions: string): string {
  if (!conventions.trim()) return '';
  return `The repository's own conventions, from its CLAUDE.md. They are written for an agent editing this code, not for you: ignore their workflow and tooling instructions, but treat the rules, limits and patterns they state as criteria the change must meet.
${conventions.trim()}

`;
}

/** Combine instruction sources (user's app-stored rules, the repo's committed file) into one block. */
export function mergeInstructions(...sources: Array<string | undefined>): string {
  return sources
    .map((s) => s?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
}
