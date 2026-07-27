import { describe, expect, it } from 'vitest';
import { buildTree } from './FileList.js';
import type { ChangedFile } from '../../../shared/ipc.js';

const f = (path: string): ChangedFile => ({ path, status: 'M' }) as ChangedFile;

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
});
