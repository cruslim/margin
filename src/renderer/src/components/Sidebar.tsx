import { useState } from 'react';
import type { RepoInfo } from '../../../shared/ipc.js';
import type { Session } from '../App.js';
import { sessionTitle } from '../App.js';

const STATUS_ICON: Record<Session['status'], string> = {
  idle: '○',
  reviewing: '◐',
  done: '●',
  error: '✕',
};

export function Sidebar(props: {
  width: number;
  repos: RepoInfo[];
  sessions: Session[];
  activeKey: string | null;
  onAddRepo: () => void;
  onNewSession: (repo: RepoInfo, baseRef: string, headRef: string | null) => void;
  onSelectSession: (key: string) => void;
  onDeleteSession: (key: string) => void;
  onRemoveRepo: (path: string) => void;
  onRefreshRepo: (path: string) => Promise<void>;
  onOpenSettings: () => void;
}) {
  const [formRepo, setFormRepo] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const refresh = (path: string) => {
    setRefreshing(path);
    props.onRefreshRepo(path).finally(() => setRefreshing((prev) => (prev === path ? null : prev)));
  };

  return (
    <aside className="sidebar" style={{ width: props.width }}>
      <div className="sidebar-header">
        <span className="logo">Margin</span>
        <span className="row-actions">
          <button className="icon-btn" title="Settings" onClick={props.onOpenSettings}>⚙</button>
          <button className="icon-btn" title="Add repository" onClick={props.onAddRepo}>+</button>
        </span>
      </div>
      <div className="sidebar-body">
        {props.repos.map((repo) => (
          <div key={repo.path} className="repo-group">
            <div className="repo-row">
              <span className="repo-label">{repo.name}</span>
              <span className="row-actions">
                <button
                  className="icon-btn row-del"
                  title="Remove repository"
                  onClick={() => props.onRemoveRepo(repo.path)}
                >
                  ✕
                </button>
                <button
                  className={`icon-btn ${refreshing === repo.path ? 'spinning' : ''}`}
                  title="Refresh branches"
                  disabled={refreshing === repo.path}
                  onClick={() => refresh(repo.path)}
                >
                  ↻
                </button>
                <button
                  className="icon-btn"
                  title="New review"
                  onClick={() => {
                    const opening = formRepo !== repo.path;
                    setFormRepo(opening ? repo.path : null);
                    if (opening) refresh(repo.path);
                  }}
                >
                  ＋
                </button>
              </span>
            </div>
            {formRepo === repo.path && (
              <NewReviewForm
                repo={repo}
                onSubmit={(base, head) => {
                  props.onNewSession(repo, base, head);
                  setFormRepo(null);
                }}
              />
            )}
            {props.sessions
              .filter((s) => s.repoPath === repo.path)
              .map((s) => (
                <div
                  key={s.key}
                  className={`session-row ${s.key === props.activeKey ? 'selected' : ''}`}
                  onClick={() => props.onSelectSession(s.key)}
                >
                  <span className={`session-status st-${s.status}`}>{STATUS_ICON[s.status]}</span>
                  <span className="session-label">{sessionTitle(s)}</span>
                  {s.findings.length > 0 && <span className="badge">{s.findings.length}</span>}
                  <button
                    className="icon-btn row-del"
                    title="Delete session"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onDeleteSession(s.key);
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
          </div>
        ))}
        {props.repos.length === 0 && (
          <div className="empty-note">No repositories yet.</div>
        )}
      </div>
    </aside>
  );
}

function NewReviewForm(props: {
  repo: RepoInfo;
  onSubmit: (baseRef: string, headRef: string | null) => void;
}) {
  const defaultBase = props.repo.branches.includes('main')
    ? 'main'
    : props.repo.branches.includes('master')
      ? 'master'
      : props.repo.branches[0] ?? 'main';
  const [base, setBase] = useState(defaultBase);
  const [head, setHead] = useState<string>('__working__');

  return (
    <form
      className="new-review-form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit(base, head === '__working__' ? null : head);
      }}
    >
      <label>
        Review
        <select value={head} onChange={(e) => setHead(e.target.value)}>
          <option value="__working__">uncommitted changes</option>
          {props.repo.branches.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>
      </label>
      {head !== '__working__' && (
        <label>
          against
          <select value={base} onChange={(e) => setBase(e.target.value)}>
            {props.repo.branches.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </label>
      )}
      <button type="submit" className="run-btn small">Open</button>
    </form>
  );
}
