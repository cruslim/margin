import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Repo-committed instructions file, kept under .margin/ to avoid another root dotfile. */
export const REPO_INSTRUCTIONS_FILE = '.margin/margin.md';

/** Claude Code project memory files, read in this order when present. */
export const CLAUDE_MD_FILES = ['CLAUDE.md', '.claude/CLAUDE.md'];

/** Claude Code project skills: one directory per skill, each holding a SKILL.md. */
export const SKILLS_DIR = '.claude/skills';

/** Caps keep a sprawling CLAUDE.md or skill library from crowding out the diff. */
const CLAUDE_MD_MAX_CHARS = 16_000;
const SKILL_BODY_MAX_CHARS = 4_000;
const SKILL_DESCRIPTION_MAX_CHARS = 300;
const MAX_SKILLS = 40;

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

function truncate(text: string, max: number, what: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n[… ${what} truncated at ${max} characters]`;
}

/** Concatenated CLAUDE.md content, each file labelled with its path. Empty when the repo has none. */
export async function readClaudeMd(workDir: string): Promise<string> {
  const parts: string[] = [];
  for (const file of CLAUDE_MD_FILES) {
    const text = (await readFile(join(workDir, file), 'utf8').catch(() => '')).trim();
    if (text) parts.push(`Repository guidance from ${file}:\n${truncate(text, CLAUDE_MD_MAX_CHARS, file)}`);
  }
  return parts.join('\n\n');
}

export interface RepoSkill {
  name: string;
  description: string;
  /** Repo-relative path to the SKILL.md, so the reviewer can Read it. */
  path: string;
  /** Markdown after the frontmatter. */
  body: string;
}

/** Minimal YAML frontmatter reader: `key: value` lines, with indented or block-scalar continuations. */
function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!match) return { fields: {}, body: raw };
  const fields: Record<string, string> = {};
  let current: string | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      current = kv[1];
      const value = kv[2].trim();
      fields[current] = /^[>|][-+]?$/.test(value) ? '' : value;
    } else if (current && /^\s+\S/.test(line)) {
      fields[current] = `${fields[current]} ${line.trim()}`.trim();
    }
  }
  for (const key of Object.keys(fields)) {
    fields[key] = fields[key].replace(/^(['"])(.*)\1$/s, '$2').trim();
  }
  return { fields, body: raw.slice(match[0].length) };
}

/** Build a skill record from a SKILL.md, falling back to the directory name and first body line. */
export function parseSkill(dirName: string, path: string, raw: string): RepoSkill {
  const { fields, body } = parseFrontmatter(raw);
  const name = fields.name?.trim() || dirName;
  const firstLine = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  const description = (fields.description?.trim() || firstLine || '').replace(/\s+/g, ' ');
  return {
    name,
    description: description.length > SKILL_DESCRIPTION_MAX_CHARS
      ? `${description.slice(0, SKILL_DESCRIPTION_MAX_CHARS).trimEnd()}…`
      : description,
    path,
    body: body.trim(),
  };
}

/** Skills committed under .claude/skills/<name>/SKILL.md, sorted by name. Empty when there are none. */
export async function listRepoSkills(workDir: string): Promise<RepoSkill[]> {
  const entries = await readdir(join(workDir, SKILLS_DIR), { withFileTypes: true }).catch(() => []);
  const skills: RepoSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = `${SKILLS_DIR}/${entry.name}/SKILL.md`;
    const raw = await readFile(join(workDir, path), 'utf8').catch(() => '');
    if (!raw.trim()) continue;
    skills.push(parseSkill(entry.name, path, raw));
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_SKILLS);
}

/**
 * Prompt block listing the repo's skills. Agentic finders get an index and are
 * told to Read the SKILL.md when it applies; tool-less finders (single-shot
 * API calls) get the bodies inlined instead, since they can't open files.
 */
export function skillsSection(skills: RepoSkill[], opts: { inline?: boolean } = {}): string {
  if (!skills.length) return '';
  const intro = opts.inline
    ? `Repository skills (from ${SKILLS_DIR}). Each holds guidance for a kind of task; apply any whose description matches the code under review:`
    : `Repository skills (from ${SKILLS_DIR}). Each SKILL.md holds guidance for a kind of task. When a skill's description matches the code under review, Read its file and apply that guidance:`;
  const items = skills.map((s) => {
    const head = `- ${s.name} — ${s.description || '(no description)'} (${s.path})`;
    if (!opts.inline || !s.body) return head;
    return `${head}\n${truncate(s.body, SKILL_BODY_MAX_CHARS, s.path)}`;
  });
  return `${intro}\n${items.join(opts.inline ? '\n\n' : '\n')}`;
}

/**
 * Everything the repo itself says about how it should be reviewed: the committed
 * .margin/margin.md, any CLAUDE.md, and an index of .claude/skills. Read from the
 * review checkout, so only committed files count. Nothing under .claude/ is
 * executed or loaded as settings — hooks and MCP servers stay off.
 */
export async function readRepoGuidance(workDir: string, opts: { inlineSkills?: boolean } = {}): Promise<string> {
  const [instructions, claudeMd, skills] = await Promise.all([
    readRepoInstructionsFile(workDir),
    readClaudeMd(workDir),
    listRepoSkills(workDir),
  ]);
  return mergeInstructions(instructions, claudeMd, skillsSection(skills, { inline: opts.inlineSkills }));
}
