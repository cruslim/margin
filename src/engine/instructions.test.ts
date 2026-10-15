import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  conventionsPreamble,
  mergeInstructions,
  readRepoConventions,
  readRepoInstructionsFile,
  REPO_INSTRUCTIONS_FILE,
} from './instructions.js';

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

describe('readRepoConventions', () => {
  it('collects the CLAUDE.md files Claude Code would load, labelled by path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'margin-conv-'));
    try {
      expect(await readRepoConventions(dir)).toBe('');
      await writeFile(join(dir, 'CLAUDE.md'), '# Root rules\n');
      await mkdir(join(dir, '.claude'), { recursive: true });
      await writeFile(join(dir, '.claude', 'CLAUDE.md'), 'nested rules');
      expect(await readRepoConventions(dir)).toBe('--- CLAUDE.md ---\n# Root rules\n\n--- .claude/CLAUDE.md ---\nnested rules');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('truncates an oversized file with a note', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'margin-conv-'));
    try {
      await writeFile(join(dir, 'CLAUDE.md'), 'x'.repeat(50_000));
      const text = await readRepoConventions(dir);
      expect(text.length).toBeLessThan(41_000);
      expect(text.endsWith('[… truncated]')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('conventionsPreamble', () => {
  it('frames the conventions as review criteria, not instructions to follow', () => {
    const block = conventionsPreamble('--- CLAUDE.md ---\nNo more than 10 constructor deps.');
    expect(block).toContain('written for an agent editing this code, not for you');
    expect(block).toContain('No more than 10 constructor deps.');
    expect(block.endsWith('\n\n')).toBe(true);
  });

  it('is empty when there are no conventions', () => {
    expect(conventionsPreamble('')).toBe('');
    expect(conventionsPreamble('  \n')).toBe('');
  });
});
