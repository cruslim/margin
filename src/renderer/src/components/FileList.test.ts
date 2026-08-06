import { describe, expect, it } from 'vitest';
import { buildTree, conversationStates, diffTotals, orderFiles } from './FileList.js';
import type { ChangedFile } from '../../../shared/ipc.js';

const f = (path: string): ChangedFile => ({ path, status: 'M' }) as ChangedFile;
const gen = (path: string): ChangedFile => ({ path, status: 'M', generated: true }) as ChangedFile;

describe('buildTree', () => {
  it('puts root-level files on the root node', () => {
    const root = buildTree([f('README.md'), f('package.json')]);
    expect(root.dirs).toHaveLength(0);
    // localeCompare is case-insensitive: p < R
    expect(root.files.map((x) => x.path)).toEqual(['package.json', 'README.md']);
  });

  it('nests directories and keeps files under their dir', () => {
    const root = buildTree([f('src/a.ts'), f('src/lib/b.ts'), f('top.md')]);
    expect(root.files.map((x) => x.path)).toEqual(['top.md']);
    const src = root.dirs[0];
    expect(src.name).toBe('src');
    expect(src.files.map((x) => x.path)).toEqual(['src/a.ts']);
    expect(src.dirs[0].name).toBe('lib');
    expect(src.dirs[0].files.map((x) => x.path)).toEqual(['src/lib/b.ts']);
  });

  it('compresses single-child directory chains', () => {
    const root = buildTree([f('src/renderer/src/components/App.tsx')]);
    expect(root.dirs).toHaveLength(1);
    expect(root.dirs[0].name).toBe('src/renderer/src/components');
    expect(root.dirs[0].path).toBe('src/renderer/src/components');
    expect(root.dirs[0].files).toHaveLength(1);
  });

  it('stops compressing where a dir has files or siblings', () => {
    const root = buildTree([f('src/main/index.ts'), f('src/preload/index.ts'), f('src/ipc.ts')]);
    const src = root.dirs[0];
    expect(src.name).toBe('src');
    expect(src.files.map((x) => x.path)).toEqual(['src/ipc.ts']);
    expect(src.dirs.map((d) => d.name)).toEqual(['main', 'preload']);
  });

  it('sorts dirs and files alphabetically', () => {
    const root = buildTree([f('z.ts'), f('a.ts'), f('b/x.ts'), f('a2/y.ts')]);
    expect(root.dirs.map((d) => d.name)).toEqual(['a2', 'b']);
    expect(root.files.map((x) => x.path)).toEqual(['a.ts', 'z.ts']);
  });

  it('sinks generated files below their hand-written siblings', () => {
    const root = buildTree([gen('a-lock.json'), f('z.ts'), gen('b.gen.ts'), f('m.ts')]);
    expect(root.files.map((x) => x.path)).toEqual(['m.ts', 'z.ts', 'a-lock.json', 'b.gen.ts']);
  });
});

describe('orderFiles', () => {
  it('puts generated last, alphabetical within each group', () => {
    const ordered = orderFiles([gen('dist/a.js'), f('src/z.ts'), gen('b.snap'), f('src/a.ts')]);
    expect(ordered.map((x) => x.path)).toEqual(['src/a.ts', 'src/z.ts', 'b.snap', 'dist/a.js']);
  });

  it('does not mutate its input', () => {
    const files = [gen('lock.json'), f('a.ts')];
    orderFiles(files);
    expect(files.map((x) => x.path)).toEqual(['lock.json', 'a.ts']);
  });
});

describe('conversationStates', () => {
  const c = (file: string, resolved?: boolean) => ({ file, resolved });

  it('returns an empty map with no comments', () => {
    expect(conversationStates([]).size).toBe(0);
  });

  it('marks a file ongoing when it has an unresolved thread', () => {
    expect(conversationStates([c('a.ts')]).get('a.ts')).toBe('ongoing');
  });

  it('marks a file resolved only when every thread is resolved', () => {
    expect(conversationStates([c('a.ts', true), c('a.ts', true)]).get('a.ts')).toBe('resolved');
  });

  it('ongoing wins over resolved regardless of order', () => {
    expect(conversationStates([c('a.ts', true), c('a.ts')]).get('a.ts')).toBe('ongoing');
    expect(conversationStates([c('a.ts'), c('a.ts', true)]).get('a.ts')).toBe('ongoing');
  });

  it('tracks files independently', () => {
    const map = conversationStates([c('a.ts'), c('b.ts', true)]);
    expect(map.get('a.ts')).toBe('ongoing');
    expect(map.get('b.ts')).toBe('resolved');
    expect(map.has('c.ts')).toBe(false);
  });
});

describe('diffTotals', () => {
  it('sums additions and deletions across files', () => {
    expect(
      diffTotals([
        { additions: 42, deletions: 0 },
        { additions: 18, deletions: 9 },
        { additions: 31, deletions: 0 },
      ]),
    ).toEqual({ additions: 91, deletions: 9 });
  });

  it('treats uncounted (binary) files as zero', () => {
    expect(diffTotals([{ additions: 5, deletions: 2 }, {}])).toEqual({ additions: 5, deletions: 2 });
  });

  it('is zero for no files', () => {
    expect(diffTotals([])).toEqual({ additions: 0, deletions: 0 });
  });
});
