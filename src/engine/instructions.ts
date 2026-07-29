import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Repo-committed instructions file, kept under .margin/ to avoid another root dotfile. */
export const REPO_INSTRUCTIONS_FILE = '.margin/margin.md';

export async function readRepoInstructionsFile(workDir: string): Promise<string> {
  return readFile(join(workDir, REPO_INSTRUCTIONS_FILE), 'utf8').catch(() => '');
}

/** Combine instruction sources (user's app-stored rules, the repo's committed file) into one block. */
export function mergeInstructions(...sources: Array<string | undefined>): string {
  return sources
    .map((s) => s?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
}
