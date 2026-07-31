/**
 * Stable id for a finding, used to name its item on the agent bridge and to
 * route the reply back to the right thread.
 *
 * Deliberately derived from the finding's identity (file + category + summary,
 * the same triple dismissals and collapse state key off) rather than its index:
 * a re-review reorders findings, and an index captured while a request was out
 * would deliver the reply onto a different finding.
 *
 * The `f-` prefix separates these from comment ids (UUIDs) in one namespace of
 * bridge items, so a reply can be routed without extra plumbing.
 */
export function findingItemId(f: { file: string; category: string; summary: string }): string {
  return `f-${fnv1a(`${f.file}::${f.category}::${f.summary}`)}`;
}

/** True for ids produced by findingItemId — the rest are comment threads. */
export function isFindingItem(id: string): boolean {
  return id.startsWith('f-');
}

/**
 * FNV-1a, 32-bit, hex. Short, filename-safe and synchronous — the renderer needs
 * it during render, where WebCrypto's async digest can't be used.
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // >>> 0 keeps it an unsigned 32-bit value; Math.imul avoids float precision loss.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
