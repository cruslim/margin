import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  listRepoSkills,
  mergeInstructions,
  parseSkill,
  readClaudeMd,
  readRepoGuidance,
  readRepoInstructionsFile,
  REPO_INSTRUCTIONS_FILE,
  SKILLS_DIR,
  skillsSection,
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

describe('readClaudeMd', () => {
  it('labels each file found and returns empty when there are none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'margin-claudemd-'));
    try {
      expect(await readClaudeMd(dir)).toBe('');
      await writeFile(join(dir, 'CLAUDE.md'), '# Conventions\n\nUse tabs.\n');
      await mkdir(join(dir, '.claude'), { recursive: true });
      await writeFile(join(dir, '.claude/CLAUDE.md'), 'Tests live next to source.');
      const text = await readClaudeMd(dir);
      expect(text).toBe(
        'Repository guidance from CLAUDE.md:\n# Conventions\n\nUse tabs.\n\nRepository guidance from .claude/CLAUDE.md:\nTests live next to source.',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('truncates oversized files with a note', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'margin-claudemd-'));
    try {
      await writeFile(join(dir, 'CLAUDE.md'), 'x'.repeat(20_000));
      const text = await readClaudeMd(dir);
      expect(text.length).toBeLessThan(17_000);
      expect(text).toMatch(/CLAUDE\.md truncated at 16000 characters\]$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('parseSkill', () => {
  const path = '.claude/skills/x/SKILL.md';

  it('reads name and description from frontmatter and keeps the body', () => {
    const skill = parseSkill('x', path, '---\nname: money\ndescription: "Rules for money math"\n---\n\n# Money\n\nUse cents.\n');
    expect(skill).toEqual({ name: 'money', description: 'Rules for money math', path, body: '# Money\n\nUse cents.' });
  });

  it('joins folded and indented multi-line descriptions', () => {
    const raw = '---\nname: api\ndescription: >-\n  Use when touching\n  the public API.\nlicense: MIT\n---\nbody';
    expect(parseSkill('api', path, raw).description).toBe('Use when touching the public API.');
  });

  it('falls back to the directory name and first body line without frontmatter', () => {
    const skill = parseSkill('deploy-checks', path, '# Deploy checks\n\nRun the smoke suite before tagging.\n');
    expect(skill.name).toBe('deploy-checks');
    expect(skill.description).toBe('Run the smoke suite before tagging.');
  });

  it('caps long descriptions', () => {
    const skill = parseSkill('x', path, `---\ndescription: ${'word '.repeat(100)}\n---\n`);
    expect(skill.description.length).toBeLessThanOrEqual(301);
    expect(skill.description.endsWith('…')).toBe(true);
  });
});

describe('listRepoSkills', () => {
  it('finds .claude/skills/*/SKILL.md sorted by name, skipping empty or non-skill entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'margin-skills-'));
    try {
      expect(await listRepoSkills(dir)).toEqual([]);
      await mkdir(join(dir, SKILLS_DIR, 'zeta'), { recursive: true });
      await mkdir(join(dir, SKILLS_DIR, 'alpha'), { recursive: true });
      await mkdir(join(dir, SKILLS_DIR, 'no-skill-file'), { recursive: true });
      await writeFile(join(dir, SKILLS_DIR, 'README.md'), 'not a skill');
      await writeFile(join(dir, SKILLS_DIR, 'zeta/SKILL.md'), '---\nname: zeta\ndescription: Z\n---\nz body');
      await writeFile(join(dir, SKILLS_DIR, 'alpha/SKILL.md'), '---\nname: alpha\ndescription: A\n---\na body');
      const skills = await listRepoSkills(dir);
      expect(skills.map((s) => [s.name, s.path])).toEqual([
        ['alpha', '.claude/skills/alpha/SKILL.md'],
        ['zeta', '.claude/skills/zeta/SKILL.md'],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('skillsSection', () => {
  const skills = [
    { name: 'alpha', description: 'A', path: '.claude/skills/alpha/SKILL.md', body: 'a body' },
    { name: 'beta', description: '', path: '.claude/skills/beta/SKILL.md', body: '' },
  ];

  it('is empty without skills', () => {
    expect(skillsSection([])).toBe('');
  });

  it('indexes skills and tells agentic finders to Read them', () => {
    const text = skillsSection(skills);
    expect(text).toContain('Read its file');
    expect(text).toContain('- alpha — A (.claude/skills/alpha/SKILL.md)');
    expect(text).toContain('- beta — (no description) (.claude/skills/beta/SKILL.md)');
    expect(text).not.toContain('a body');
  });

  it('inlines bodies for tool-less finders', () => {
    const text = skillsSection(skills, { inline: true });
    expect(text).not.toContain('Read its file');
    expect(text).toContain('(.claude/skills/alpha/SKILL.md)\na body');
  });
});

describe('readRepoGuidance', () => {
  it('merges margin.md, CLAUDE.md, and the skills index in that order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'margin-guidance-'));
    try {
      expect(await readRepoGuidance(dir)).toBe('');
      await mkdir(join(dir, '.margin'), { recursive: true });
      await writeFile(join(dir, REPO_INSTRUCTIONS_FILE), 'team rules');
      await writeFile(join(dir, 'CLAUDE.md'), 'claude rules');
      await mkdir(join(dir, SKILLS_DIR, 's'), { recursive: true });
      await writeFile(join(dir, SKILLS_DIR, 's/SKILL.md'), '---\nname: s\ndescription: D\n---\nS body');
      const text = await readRepoGuidance(dir);
      const order = ['team rules', 'Repository guidance from CLAUDE.md:\nclaude rules', 'Repository skills', '- s — D'].map((m) =>
        text.indexOf(m),
      );
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(text).not.toContain('S body');
      expect(await readRepoGuidance(dir, { inlineSkills: true })).toContain('S body');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
