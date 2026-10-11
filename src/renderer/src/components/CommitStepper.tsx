import { useEffect } from 'react';
import type { CommitInfo } from '../../../shared/ipc.js';
import { selectionSpan, type CommitSelection } from './lens.js';

/**
 * Where to step from the current view. `older`/`newer` move one commit at a
 * time; from All changes, newer starts at the first commit — reading a branch
 * from the beginning is the walkthrough — and older starts at the latest.
 * A span collapses to the commit just past its end. Exported for tests.
 */
export function stepTarget(
  commits: CommitInfo[],
  sel: CommitSelection | null,
  dir: 'older' | 'newer',
): CommitSelection | null {
  if (commits.length === 0) return null;
  const span = selectionSpan(commits, sel);
  let i: number;
  if (!span) i = dir === 'newer' ? commits.length - 1 : 0;
  else i = dir === 'newer' ? span.newest - 1 : span.oldest + 1;
  if (i < 0 || i >= commits.length) return null;
  return { anchor: commits[i].hash, end: commits[i].hash };
}

/**
 * Topbar control for commit view: step through the branch a commit at a time,
 * or go back to the whole changeset. Lives in the topbar rather than only the
 * sidebar's commit list so it still works with the sidebar collapsed.
 */
export function CommitStepper(props: {
  commits: CommitInfo[];
  selection: CommitSelection | null;
  /** Commits since the last review, when there are any — offered as a shortcut. */
  sinceReview: CommitSelection | null;
  onSelect: (sel: CommitSelection | null) => void;
}) {
  const { commits, selection } = props;
  const span = selectionSpan(commits, selection);
  const older = stepTarget(commits, selection, 'older');
  const newer = stepTarget(commits, selection, 'newer');

  // [ and ] step, like a pager — skipped while typing, where they're just brackets.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (e.key === '[' && older) props.onSelect(older);
      else if (e.key === ']' && newer) props.onSelect(newer);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [older, newer, props.onSelect]);

  if (commits.length === 0) return null;

  let label: string;
  let detail: string | undefined;
  if (!span) label = 'All changes';
  else if (span.newest === span.oldest) {
    const c = commits[span.newest];
    label = `${commits.length - span.newest}/${commits.length} · ${c.sha} ${c.subject}`;
    detail = `${c.subject}\n${c.sha} · ${c.author} · ${new Date(c.date).toLocaleString()}`;
  } else {
    const n = span.oldest - span.newest + 1;
    label = `${commits[span.oldest].sha}…${commits[span.newest].sha} · ${n} commits`;
  }
  const isSinceReview =
    !!props.sinceReview &&
    !!span &&
    commits[span.newest].hash === props.sinceReview.end &&
    commits[span.oldest].hash === props.sinceReview.anchor;

  return (
    <div className="commit-stepper">
      <button
        className="icon-btn"
        disabled={!older}
        title="Older commit  ["
        onClick={() => older && props.onSelect(older)}
      >
        ‹
      </button>
      <span className={`commit-stepper-label ${span ? 'active' : ''}`} title={detail ?? label}>
        {label}
      </span>
      <button
        className="icon-btn"
        disabled={!newer}
        title="Newer commit  ]"
        onClick={() => newer && props.onSelect(newer)}
      >
        ›
      </button>
      {span && (
        <button className="icon-btn" title="Back to the whole changeset" onClick={() => props.onSelect(null)}>
          all changes
        </button>
      )}
      {props.sinceReview && !isSinceReview && (
        <button
          className="icon-btn"
          title="Just the commits made since the last review"
          onClick={() => props.onSelect(props.sinceReview)}
        >
          since review
        </button>
      )}
    </div>
  );
}
