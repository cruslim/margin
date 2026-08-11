import type { RefState } from '../../../shared/ipc.js';

/** What to call the changeset's base, and why it isn't simply the session's base ref. */
export interface BaseLabel {
  /** Ref the changeset is actually against. */
  ref: string;
  /** Short parenthetical for the discrepancy; absent when there is none. */
  note?: string;
  /** The same thing spelled out, for a tooltip. */
  detail?: string;
  /** Ref this branch has already landed in, when it has — worth flagging on its own. */
  merged?: string;
}

/**
 * Describe a session's base for the header and the sidebar, from the refs as
 * resolved (see resolveBase). Both surfaces render the same words: a branch
 * compared against something other than the ref its session names should say so
 * identically wherever it says it.
 */
export function baseLabel(baseRef: string, refs?: Pick<RefState, 'baseVia' | 'mergedInto'>): BaseLabel {
  if (refs?.baseVia) {
    const { ref, behind, landed } = refs.baseVia;
    // A landed base ref gets no commit count: it would read as a statement about
    // `ref` — "103 behind" of a branch you just rebased onto is alarming and
    // wrong — when what it measures is how old the base ref itself now is.
    return landed
      ? {
          ref,
          note: `original base ${baseRef} has been merged`,
          detail: `${baseRef}, this session's original base, has been merged into ${ref} — which is ${behind} commit(s) further on than where that branch stopped. This branch now sits on ${ref}, so it's compared against that, and what came from there stays out of the changeset.`,
        }
      : {
          ref,
          // "on local", because the ref beside it is the remote one of the same
          // name: without that, "main is 22 behind" looks like it contradicts
          // itself, being a claim about `main` sitting next to `origin/main`.
          note: `${baseRef} on local is ${behind} behind`,
          detail: `This branch now sits on ${ref}, which your local ${baseRef} is ${behind} commit(s) behind — comparing against ${ref}, so what came from there stays out of the changeset.`,
        };
  }
  if (refs?.mergedInto) {
    return {
      ref: baseRef,
      note: `already in ${refs.mergedInto}`,
      detail: `This branch is already wholly in ${refs.mergedInto}, so nothing is ahead of it — comparing against ${baseRef} instead, which is the only ref the branch's work is still visible against.`,
      merged: refs.mergedInto,
    };
  }
  return { ref: baseRef };
}
