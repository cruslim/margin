import { EMPTY_TREE } from '../../../shared/ipc.js';
import type { Comment, CommitInfo, CommitRange, Finding, LensMap } from '../../../shared/ipc.js';
import { reanchor } from './reanchor.js';

/**
 * Commit view: a lens over the branch's history, not a second place to keep
 * comments. Everything stays anchored to the branch tip; these helpers place
 * tip-anchored threads in a commit's version of a file, and translate a new
 * comment made there back onto the tip — or refuse it when the lines it would
 * be about no longer exist there.
 */

/**
 * Which commits are being viewed: two ends, in either order (a shift-click can
 * extend a selection upwards or downwards). One commit when they're the same.
 * Held as full shas so a refreshed commit list can tell whether they survived.
 */
export interface CommitSelection {
  anchor: string;
  end: string;
}

/**
 * The selection's ends as indices into the commit list (newest first), or null
 * when either end is no longer on the branch — a rebase or amend rewrote it.
 */
export function selectionSpan(commits: CommitInfo[], sel: CommitSelection | null): { newest: number; oldest: number } | null {
  if (!sel) return null;
  const a = commits.findIndex((c) => c.hash === sel.anchor);
  const b = commits.findIndex((c) => c.hash === sel.end);
  if (a === -1 || b === -1) return null;
  return { newest: Math.min(a, b), oldest: Math.max(a, b) };
}

/** The diff a selection stands for: from the oldest commit's parent to the newest commit. */
export function rangeOf(commits: CommitInfo[], sel: CommitSelection | null): CommitRange | null {
  const span = selectionSpan(commits, sel);
  if (!span) return null;
  return { from: commits[span.oldest].parent || EMPTY_TREE, to: commits[span.newest].hash };
}

/**
 * Commits added since the last review, as a selection — null when there are
 * none, or the reviewed commit isn't on the branch any more (a rebase).
 */
export function sinceReviewSelection(commits: CommitInfo[], lastReviewedSha: string | undefined): CommitSelection | null {
  if (!lastReviewedSha) return null;
  const k = commits.findIndex((c) => c.hash === lastReviewedSha);
  if (k <= 0) return null;
  return { anchor: commits[k - 1].hash, end: commits[0].hash };
}

/** Tip line → commit line, for lines that survive. */
function inverse(lens: LensMap): Map<number, number> {
  const inv = new Map<number, number>();
  lens.tipLine.forEach((t, i) => {
    if (t !== null) inv.set(t, i + 1);
  });
  return inv;
}

/**
 * Findings for the open file, placed in the commit's version. Expects them
 * already re-anchored against the tip — App does that once for the findings
 * panel too. A finding whose line was rewritten later, or not written yet, has
 * nowhere to sit and is left out; it's still in the panel and in All changes.
 */
export function lensFindings(findings: Finding[], lens: LensMap): Finding[] {
  if (!lens.tipPath) return [];
  const inv = inverse(lens);
  const out: Finding[] = [];
  for (const f of findings) {
    if (f.file !== lens.tipPath) continue;
    const line = inv.get(f.line);
    if (line !== undefined) out.push(line === f.line ? f : { ...f, line });
  }
  return out;
}

/**
 * Comment threads for the open file, placed in the commit's version. Only the
 * new side: an old-side thread is about the base, which a commit's left-hand
 * side only is for the first commit — not worth a special case.
 */
export function lensComments(comments: Comment[], lens: LensMap): Comment[] {
  if (!lens.tipPath) return [];
  const inv = inverse(lens);
  const out: Comment[] = [];
  for (const c of comments) {
    if (c.file !== lens.tipPath || c.side !== 'new') continue;
    const at = reanchor(lens.tipContent, c, c.quoted);
    const startLine = inv.get(at.startLine);
    const endLine = inv.get(at.endLine);
    if (startLine === undefined || endLine === undefined) continue;
    out.push(startLine === c.startLine && endLine === c.endLine ? c : { ...c, startLine, endLine });
  }
  return out;
}

export type TipSpan =
  | { ok: true; file: string; startLine: number; endLine: number }
  | { ok: false; by: LensMap['superseded'][number]['by'] };

/**
 * Where a commit-side line span lives at the tip. Every line must survive, and
 * stay consecutive — a span that straddles a later insertion would land as
 * something other than what was selected. Refusals name the commit that got
 * in the way, so the UI can offer to go there.
 */
export function tipSpan(lens: LensMap, startLine: number, endLine: number): TipSpan {
  const blocker = (line: number) => lens.superseded.find((r) => line >= r.start && line <= r.end)?.by ?? null;
  if (!lens.tipPath) return { ok: false, by: blocker(startLine) };
  for (let l = startLine; l <= endLine; l++) {
    const t = lens.tipLine[l - 1];
    if (t == null) return { ok: false, by: blocker(l) };
    // Consecutive here but split apart at the tip: something was inserted in
    // between later — no single superseding commit to point at.
    if (l > startLine && t !== lens.tipLine[l - 2]! + 1) return { ok: false, by: null };
  }
  return { ok: true, file: lens.tipPath, startLine: lens.tipLine[startLine - 1]!, endLine: lens.tipLine[endLine - 1]! };
}
