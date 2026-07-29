import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeInstructions, readRepoInstructionsFile, REPO_INSTRUCTIONS_FILE } from './instructions.js';

describe('mergeInstructions', () => {
  it('joins non-empty sources with a blank line', () => {
    expect(mergeInstructions('app rules', 'repo rules')).toBe('app rules\n\nrepo rules');
  });

  it('drops undefined and whitespace-only sources', () => {
    expect(mergeInstructions(undefined, '  \n', 'x')).toBe('x');
    expect(mergeInstructions()).toBe('');
    expect(mergeInstructions(undefined, '')).toBe('');
  });
});

describe('readRepoInstructionsFile', () => {
  it('reads .margin/margin.md, empty when absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'margin-instr-'));
    try {
      expect(await readRepoInstructionsFile(dir)).toBe('');
      await mkdir(join(dir, '.margin'), { recursive: true });
      await writeFile(join(dir, REPO_INSTRUCTIONS_FILE), 'team rules\n');
      expect(await readRepoInstructionsFile(dir)).toBe('team rules\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
