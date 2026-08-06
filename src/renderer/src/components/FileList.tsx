import { Fragment, useMemo, useState } from 'react';
import type { ChangedFile, Comment } from '../../../shared/ipc.js';

type ViewMode = 'list' | 'tree';

export type ConvoState = 'ongoing' | 'resolved';

/** Per-file conversation state: 'ongoing' if any thread is unresolved, 'resolved' if all are. */
export function conversationStates(comments: Pick<Comment, 'file' | 'resolved'>[]): Map<string, ConvoState> {
  const map = new Map<string, ConvoState>();
  for (const c of comments) {
    if (!c.resolved) map.set(c.file, 'ongoing');
    else if (map.get(c.file) !== 'ongoing') map.set(c.file, 'resolved');
  }
  return map;
}

export type DirNode = {
  name: string;
  path: string;
  dirs: DirNode[];
  files: ChangedFile[];
};

export function buildTree(files: ChangedFile[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: [], files: [] };
  const byPath = new Map<string, DirNode>([['', root]]);
  const dirFor = (path: string): DirNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const cut = path.lastIndexOf('/');
    const parent = dirFor(cut === -1 ? '' : path.slice(0, cut));
    const node: DirNode = { name: path.slice(cut + 1), path, dirs: [], files: [] };
    parent.dirs.push(node);
    byPath.set(path, node);
    return node;
  };
  for (const f of files) {
    const cut = f.path.lastIndexOf('/');
    dirFor(cut === -1 ? '' : f.path.slice(0, cut)).files.push(f);
  }
  collapseChains(root);
  sortTree(root);
  return root;
}

/** Merge single-child directory chains (src → services → x becomes "src/services/x"). */
function collapseChains(node: DirNode) {
  for (const dir of node.dirs) {
    while (dir.files.length === 0 && dir.dirs.length === 1) {
      const only = dir.dirs[0];
      dir.name = `${dir.name}/${only.name}`;
      dir.path = only.path;
      dir.dirs = only.dirs;
      dir.files = only.files;
    }
    collapseChains(dir);
  }
}

/** Hand-written files first, then generated output; alphabetical within each group. */
export function orderFiles(files: ChangedFile[]): ChangedFile[] {
  return [...files].sort(
    (a, b) => Number(!!a.generated) - Number(!!b.generated) || a.path.localeCompare(b.path),
  );
}

function sortTree(node: DirNode) {
  node.dirs.sort((a, b) => a.name.localeCompare(b.name));
  node.files = orderFiles(node.files);
  for (const dir of node.dirs) sortTree(dir);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

const ListIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
  </svg>
);

const BubbleIcon = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <path d="M8 1.5c-3.9 0-7 2.5-7 5.7 0 1.9 1.1 3.5 2.8 4.6-.1.9-.5 1.8-1.2 2.5 1.4-.1 2.6-.6 3.6-1.4.6.1 1.2.2 1.8.2 3.9 0 7-2.6 7-5.9S11.9 1.5 8 1.5z" />
  </svg>
);

const TreeIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M4.5 3v8a1.5 1.5 0 0 0 1.5 1.5h3M4.5 7.5H9" />
    <circle cx="4.5" cy="3" r="1.6" />
    <circle cx="11.5" cy="7.5" r="1.6" />
    <circle cx="11.5" cy="12.5" r="1.6" />
  </svg>
);

/** Marks a file as machine-generated. Also used in the diff toolbar. */
export const GenBadge = () => <span className="file-gen">auto-generated</span>;

/** Summed line counts for the toolbar; files without counts (binary) contribute nothing. */
export function diffTotals(files: Pick<ChangedFile, 'additions' | 'deletions'>[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions ?? 0;
    deletions += f.deletions ?? 0;
  }
  return { additions, deletions };
}

/** GitHub-style +N −M line counts; zero sides are dropped, binary files render nothing. */
const DiffStat = ({ additions, deletions }: Pick<ChangedFile, 'additions' | 'deletions'>) =>
  !additions && !deletions ? null : (
    <span className="file-stat">
      {additions ? <span className="stat-add">+{additions}</span> : null}
      {deletions ? <span className="stat-del">−{deletions}</span> : null}
    </span>
  );

export function FileList(props: {
  files: ChangedFile[];
  selected: string | null;
  flagged: Set<string>;
  conversations: Map<string, ConvoState>;
  onSelect: (path: string) => void;
}) {
  const [mode, setMode] = useState<ViewMode>(
    () => (localStorage.getItem('margin.filelist.view') === 'list' ? 'list' : 'tree'),
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => buildTree(props.files), [props.files]);
  const ordered = useMemo(() => orderFiles(props.files), [props.files]);
  const totals = useMemo(() => diffTotals(props.files), [props.files]);

  const setView = (m: ViewMode) => {
    setMode(m);
    localStorage.setItem('margin.filelist.view', m);
  };
  const toggleDir = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const fileRow = (f: ChangedFile, depth: number, label: string, rtl: boolean) => {
    const convo = props.conversations.get(f.path);
    return (
      <button
        key={f.path}
        className={`file-item ${f.path === props.selected ? 'selected' : ''} ${f.generated ? 'generated' : ''}`}
        style={depth > 0 ? { paddingLeft: 7 + depth * 14 } : undefined}
        title={f.generated ? `${f.path} (auto-generated)` : f.path}
        onClick={() => props.onSelect(f.path)}
      >
        <span className={`file-status status-${f.status}`}>{f.status}</span>
        <span className={`file-path ${rtl ? 'rtl' : ''}`}>{label}</span>
        {f.generated && <GenBadge />}
        {convo && (
          <span
            className={`file-convo ${convo}`}
            title={convo === 'ongoing' ? 'Ongoing conversation' : 'All conversations resolved'}
          >
            {BubbleIcon}
          </span>
        )}
        {props.flagged.has(f.path) && <span className="file-flag">●</span>}
        <DiffStat additions={f.additions} deletions={f.deletions} />
      </button>
    );
  };

  const renderDir = (node: DirNode, depth: number): React.ReactNode => (
    <>
      {node.dirs.map((dir) => {
        const isCollapsed = collapsed.has(dir.path);
        return (
          <Fragment key={dir.path}>
            <button
              className="file-item dir-row"
              style={{ paddingLeft: 7 + depth * 14 }}
              title={dir.path}
              onClick={() => toggleDir(dir.path)}
            >
              <span className="dir-chevron">{isCollapsed ? '▸' : '▾'}</span>
              <span className="dir-name">{dir.name}</span>
            </button>
            {!isCollapsed && renderDir(dir, depth + 1)}
          </Fragment>
        );
      })}
      {node.files.map((f) => fileRow(f, depth, baseName(f.path), false))}
    </>
  );

  return (
    <>
      <div className="filelist-toolbar">
        <span className="filelist-count">
          {props.files.length} file{props.files.length === 1 ? '' : 's'}
          {totals.additions > 0 && <span className="stat-add"> +{totals.additions}</span>}
          {totals.deletions > 0 && <span className="stat-del"> −{totals.deletions}</span>}
        </span>
        <span className="view-toggle">
          <button
            className={`icon-btn ${mode === 'tree' ? 'active' : ''}`}
            title="Tree view"
            onClick={() => setView('tree')}
          >
            {TreeIcon}
          </button>
          <button
            className={`icon-btn ${mode === 'list' ? 'active' : ''}`}
            title="List view"
            onClick={() => setView('list')}
          >
            {ListIcon}
          </button>
        </span>
      </div>
      <div className="filelist-items">
        {mode === 'tree'
          ? renderDir(tree, 0)
          : ordered.map((f) => fileRow(f, 0, f.path, true))}
        {props.files.length === 0 && <div className="empty-note">No changed files</div>}
      </div>
    </>
  );
}
