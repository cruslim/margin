/**
 * Re-anchor a line-anchored annotation by its quoted content.
 *
 * Comments and findings store a line range plus the text that range held when
 * they were created. Once the file moves under them — a new commit, a refresh,
 * a re-review — the numbers point at the wrong code. Matching the stored text
 * back into the current content recovers the intended lines.
 *
 * Display-only: callers keep the stored anchor and shift the copy they render,
 * so the next refresh re-derives from the original rather than compounding.
 */
export interface Anchor {
  startLine: number;
  endLine: number;
}

export function reanchor(content: string, anchor: Anchor, quoted: string | undefined): Anchor {
  // Nothing to match on, or a blank quote that would match anywhere.
  if (!quoted?.trim()) return anchor;

  const lines = content.split('\n');
  const wanted = quoted.split('\n');
  const span = wanted.length;
  const matchesAt = (i: number) => wanted.every((w, k) => lines[i + k] === w);

  // Still correct — the common case, and cheapest to check first.
  if (matchesAt(anchor.startLine - 1)) return anchor;

  // Otherwise take the match nearest the original position: a duplicated block
  // (a repeated guard clause, an import line) should resolve to the one the
  // annotation was closest to, not the first in the file.
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i + span <= lines.length; i++) {
    if (!matchesAt(i)) continue;
    const distance = Math.abs(i - (anchor.startLine - 1));
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  // No match: the quoted code is gone. Leave the anchor put rather than guess.
  if (best === -1) return anchor;

  return { startLine: best + 1, endLine: best + span };
}
