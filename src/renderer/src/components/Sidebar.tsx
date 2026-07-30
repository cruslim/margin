import { Fragment, useState } from 'react';
import { BranchSelect } from './BranchSelect.js';
import type { CommitInfo, RepoInfo } from '../../../shared/ipc.js';
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
  /** Re-read this branch's changeset (picks up commits made since it was opened). */
  onRefreshSession: (key: string) => Promise<void>;
  /** Commits on the selected branch, listed under its row. */
  activeCommits: CommitInfo[];
  onRemoveRepo: (path: string) => void;
  onRefreshRepo: (path: string) => Promise<void>;
  onEditInstructions: (repo: RepoInfo) => void;
  onOpenSettings: () => void;
}) {
  const [formRepo, setFormRepo] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const refresh = (path: string) => {
    setRefreshing(path);
    props.onRefreshRepo(path).finally(() => setRefreshing((prev) => (prev === path ? null : prev)));
  };
  const refreshSession = (key: string) => {
    setRefreshing(key);
    props.onRefreshSession(key).finally(() => setRefreshing((prev) => (prev === key ? null : prev)));
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
                  className="icon-btn"
                  title="Review instructions for this repo"
                  onClick={() => props.onEditInstructions(repo)}
                >
                  ✎
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
                onCancel={() => setFormRepo(null)}
              />
            )}
            {props.sessions
              .filter((s) => s.repoPath === repo.path)
              .map((s) => (
                <Fragment key={s.key}>
                <div
                  className={`session-row ${s.key === props.activeKey ? 'selected' : ''}`}
                  onClick={() => props.onSelectSession(s.key)}
                >
                  <span className={`session-status st-${s.status}`}>{STATUS_ICON[s.status]}</span>
                  <span className="session-label">{sessionTitle(s)}</span>
                  {s.findings.length > 0 && <span className="badge">{s.findings.length}</span>}
                  <button
                    className={`icon-btn row-refresh ${refreshing === s.key ? 'spinning' : ''}`}
                    title="Refresh this branch's changes"
                    disabled={refreshing === s.key}
                    onClick={(e) => {
                      e.stopPropagation();
                      refreshSession(s.key);
                    }}
                  >
                    ↻
                  </button>
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
                {s.key === props.activeKey && s.headRef && (
                  <CommitList commits={props.activeCommits} baseRef={s.baseRef} />
                )}
                </Fragment>
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

/**
 * Commits on the selected branch. Read-only orientation — the sidebar is narrow,
 * so each row is sha + subject and the full detail goes in the tooltip.
 */
function CommitList(props: { commits: CommitInfo[]; baseRef: string }) {
  // Own hover card rather than `title`: the native tooltip waits a second or
  // more, and it's the truncated subject people need to read straight away.
  const [hover, setHover] = useState<{ commit: CommitInfo; top: number; left: number } | null>(null);

  if (props.commits.length === 0) {
    return <div className="commit-list empty-note">No commits ahead of {props.baseRef}</div>;
  }
  return (
    <div className="commit-list">
      {props.commits.map((c) => (
        <div
          key={c.sha}
          className="commit-row"
          onMouseEnter={(e) => setHover({ commit: c, ...tooltipPosition(e.clientX, e.clientY) })}
          onMouseLeave={() => setHover((h) => (h?.commit.sha === c.sha ? null : h))}
        >
          <span className="commit-sha">{c.sha}</span>
          <span className="commit-subject">{c.subject}</span>
        </div>
      ))}
      {hover && (
        <div className="commit-tooltip" style={{ top: hover.top, left: hover.left }}>
          <div className="commit-tooltip-subject">{hover.commit.subject}</div>
          <div className="commit-tooltip-meta">
            {hover.commit.sha} · {hover.commit.author} · {new Date(hover.commit.date).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}

/** Rough card size, for keeping it on screen near the window's edges. */
const TOOLTIP_MAX_HEIGHT = 96;
const TOOLTIP_MAX_WIDTH = 420;

/**
 * Place the card just below the pointer, flipping above it near the bottom edge
 * and pulling left of it near the right edge so it never leaves the window.
 */
function tooltipPosition(x: number, y: number): { top: number; left: number } {
  const below = y + 18;
  return {
    top: below + TOOLTIP_MAX_HEIGHT > window.innerHeight ? Math.max(4, y - TOOLTIP_MAX_HEIGHT) : below,
    left: Math.max(4, Math.min(x + 4, window.innerWidth - TOOLTIP_MAX_WIDTH - 8)),
  };
}

function NewReviewForm(props: {
  repo: RepoInfo;
  onSubmit: (baseRef: string, headRef: string | null) => void;
  onCancel: () => void;
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
        <BranchSelect
          value={head}
          options={[
            { value: '__working__', label: 'uncommitted changes' },
            ...props.repo.branches.map((b) => ({ value: b, label: b })),
          ]}
          onChange={setHead}
        />
      </label>
      {head !== '__working__' && (
        <label>
          against
          <BranchSelect
            value={base}
            options={props.repo.branches.map((b) => ({ value: b, label: b }))}
            onChange={setBase}
          />
        </label>
      )}
      <div className="form-actions">
        <button type="submit" className="run-btn small">Open</button>
        <button type="button" className="cancel-btn small" onClick={props.onCancel}>Cancel</button>
      </div>
    </form>
  );
}
