import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Check out `ref` into a detached temporary worktree so the review session
 * reads a stable snapshot and never touches the user's working copy.
 * The worktree stays alive after the review so chat can keep reading files;
 * call removeWorktree() when the session is closed.
 */
export async function createWorktree(repoPath: string, ref: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'margin-'));
  await git(repoPath, ['worktree', 'add', '--detach', dir, ref]);
  return dir;
}

export async function removeWorktree(repoPath: string, worktreeDir: string): Promise<void> {
  await git(repoPath, ['worktree', 'remove', '--force', worktreeDir]).catch(() => {});
  await rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
}

/** Does `ancestor` lead to `descendant`? False for either ref being unknown. */
export async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false; // exit 1 for "no", 128 for a ref that doesn't resolve
  }
}

async function mergeBase(repoPath: string, a: string, b: string): Promise<string | null> {
  try {
    return (await git(repoPath, ['merge-base', a, b])).trim();
  } catch {
    return null; // unrelated histories, or a ref that doesn't resolve
  }
}

/** The base ref's remote-tracking counterpart, e.g. `master` → `origin/master`. */
async function upstreamOf(repoPath: string, ref: string): Promise<string | null> {
  try {
    return (await git(repoPath, ['rev-parse', '--abbrev-ref', `${ref}@{upstream}`])).trim();
  } catch {
    return null; // no upstream configured, or the tracking ref is gone
  }
}

/**
 * The mainline work lands in, as both names it goes by: the remote's default
 * branch (e.g. `origin/master`, from the remote HEAD git records at clone time)
 * and the local branch tracking it. Resolved against the remote the base ref
 * tracks, so a repo with several remotes picks the right one.
 */
async function mainlineOf(repoPath: string, baseRef: string): Promise<{ remote: string; local: string | null } | null> {
  const remoteName =
    (await git(repoPath, ['config', '--get', `branch.${baseRef}.remote`]).catch(() => 'origin')).trim() || 'origin';
  let remote: string;
  try {
    const full = (await git(repoPath, ['symbolic-ref', `refs/remotes/${remoteName}/HEAD`])).trim();
    remote = full.replace(/^refs\/remotes\//, '');
  } catch {
    return null; // no remote HEAD recorded (or no such remote)
  }
  if (!remote) return null;
  const name = remote.slice(remoteName.length + 1);
  const local = name && (await refExists(repoPath, `refs/heads/${name}`)) ? name : null;
  return { remote, local };
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

/** A ref the branch may sit on rather than its base ref, and how it relates to it. */
interface BaseCandidate {
  ref: string;
  /** True when this is the mainline the base ref has landed in, rather than the base's own upstream. */
  landed: boolean;
}

/**
 * Refs the branch may sit on rather than its base ref: the base's own remote
 * counterpart, and the mainline under either name. Only refs the base ref is
 * wholly contained in qualify — see resolveBase for why that restraint matters.
 *
 * Local mainline first, so a branch rebased onto a local `master` is described
 * by the ref the rebase actually named; the remote one only wins by reaching
 * strictly further, which is what happens when the rebase used it instead.
 */
async function baseCandidates(repoPath: string, baseRef: string): Promise<BaseCandidate[]> {
  const mainline = await mainlineOf(repoPath, baseRef);
  const upstream = await upstreamOf(repoPath, baseRef);
  const ordered: BaseCandidate[] = [
    ...(mainline?.local ? [{ ref: mainline.local, landed: true }] : []),
    ...(upstream ? [{ ref: upstream, landed: false }] : []),
    ...(mainline ? [{ ref: mainline.remote, landed: mainline.remote !== upstream }] : []),
  ];
  const usable: BaseCandidate[] = [];
  for (const candidate of ordered) {
    if (candidate.ref === baseRef || usable.some((u) => u.ref === candidate.ref)) continue;
    if (await isAncestor(repoPath, baseRef, candidate.ref)) usable.push(candidate);
  }
  return usable;
}

/** Base a branch is compared against, and where it came from. */
export interface BaseResolution {
  /** Commit to diff and log against. */
  sha: string;
  /**
   * Set when `sha` came from a ref the branch now sits on rather than the base
   * ref itself, with how far the base ref lags that ref. `landed` distinguishes
   * the two reasons: the base ref has been merged into this one (a stack's lower
   * branch, say), rather than being the same branch further on.
   */
  via?: { ref: string; behind: number; landed: boolean };
  /**
   * Set when the branch is already wholly contained in this ref — merged and
   * pushed. Nothing is "ahead" of that ref any more, so `sha` stays on the base
   * ref to keep the branch's work reviewable; this says why.
   */
  mergedInto?: string;
}

/**
 * Resolve what a branch should actually be compared against.
 *
 * The obvious answer is the merge-base with baseRef, but that is wrong whenever
 * the branch has been rebased past where its base ref still sits. Two shapes of
 * that, both common:
 *
 * - Base is your local `master`, you `git rebase origin/master`, and local
 *   `master` is behind the remote. The branch now holds the upstream commits the
 *   rebase pulled in, yet the merge-base with the stale `master` is still the old
 *   branch point, so those commits read as the branch's own work.
 * - Base is the branch below it in a stack, that one has since landed in the
 *   mainline (its remote branch deleted with the merged PR), and this one has
 *   been rebased onto the new mainline. The merge-base with the landed base is
 *   where it was *then*, so the whole mainline since reads as this branch's work
 *   — hundreds of commits for a two-commit branch.
 *
 * So each candidate ref (see baseCandidates) offers its own merge-base with the
 * head, and the one furthest along wins: that is the latest point the branch and
 * something it sits on still agree, which is where its own work starts.
 *
 * Two restraints keep this from overreaching:
 *
 * - A candidate only counts if the base ref is wholly contained in it — it is
 *   the same branch further on, or the mainline the base has landed in. Without
 *   that, a deliberately old base (a release branch, say) would be silently
 *   overridden by the mainline, hiding exactly what was asked for. It is also
 *   what keeps a healthy stack intact: a base branch sitting *above* the mainline
 *   isn't contained in it, so the stack's own base is kept.
 * - A branch already merged and pushed must not advance at all. The candidate's
 *   merge-base is then the branch tip itself, and advancing would leave an empty
 *   changeset — no commits, no files, nothing to review. Such a session stays on
 *   its base ref, the only remaining ref its work is visible against.
 *
 * All of which leaves this inert for the ordinary case: a branch that was never
 * rebased holds none of the upstream commits, so every candidate's merge-base is
 * the same commit as the base's own and nothing changes.
 */
export async function resolveBase(repoPath: string, baseRef: string, headRef: string): Promise<BaseResolution> {
  const direct = await mergeBase(repoPath, baseRef, headRef);
  let best = direct;
  let via: BaseCandidate | null = null;
  for (const candidate of await baseCandidates(repoPath, baseRef)) {
    const sha = await mergeBase(repoPath, candidate.ref, headRef);
    if (!sha) continue;
    // A merge-base with the head is always an ancestor of it, so it can only
    // contain the head by *being* it: the branch is wholly in this ref.
    if (await isAncestor(repoPath, headRef, sha)) {
      return { sha: direct ?? baseRef, mergedInto: candidate.ref };
    }
    // Strictly further only, so an equally good candidate keeps the earlier —
    // and the earlier is the name closest to what the rebase named.
    if (sha === best) continue;
    if (!best || (await isAncestor(repoPath, best, sha))) {
      best = sha;
      via = candidate;
    }
  }
  if (!best) return { sha: baseRef };
  if (!via) return { sha: best };
  return { sha: best, via: { ...via, behind: await countAhead(repoPath, baseRef, via.ref) } };
}

/** How many commits `to` has that `from` doesn't. 0 if either ref is unknown. */
async function countAhead(repoPath: string, from: string, to: string): Promise<number> {
  try {
    return Number((await git(repoPath, ['rev-list', '--count', `${from}..${to}`])).trim()) || 0;
  } catch {
    return 0;
  }
}

export async function effectiveBaseSha(repoPath: string, baseRef: string, headRef: string): Promise<string> {
  return (await resolveBase(repoPath, baseRef, headRef)).sha;
}

/**
 * Diff of a branch against its effective base (what a PR would show). Passing a
 * commit as baseRef — a delta review's sinceSha — compares against that commit
 * directly, since a sha has no upstream to advance to.
 */
export async function branchDiff(repoPath: string, baseRef: string, headRef: string): Promise<string> {
  return git(repoPath, ['diff', await effectiveBaseSha(repoPath, baseRef, headRef), headRef]);
}

/** Untracked (never git-added) files, honoring .gitignore. */
export async function untrackedPaths(repoPath: string): Promise<string[]> {
  const out = await git(repoPath, ['ls-files', '--others', '--exclude-standard', '-z']);
  return out.split('\0').filter(Boolean);
}

/**
 * New-file diff for an untracked path — plain `git diff` never shows untracked
 * files. `--no-index` against /dev/null renders a proper new-file diff,
 * including binary detection and no-newline markers (header-only for an empty
 * file), but always exits 1, so the "error" is the success path here.
 */
export async function untrackedFileDiff(repoPath: string, path: string): Promise<string> {
  try {
    await git(repoPath, ['diff', '--no-index', '--', '/dev/null', path]);
    return '';
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    if (e.code === 1 && typeof e.stdout === 'string') return e.stdout;
    throw err;
  }
}

/** Diff of uncommitted changes (staged + unstaged + untracked) against HEAD. */
export async function workingTreeDiff(repoPath: string): Promise<string> {
  const tracked = await git(repoPath, ['diff', 'HEAD']);
  const untracked = await untrackedPaths(repoPath);
  const extra = await Promise.all(untracked.map((p) => untrackedFileDiff(repoPath, p)));
  return [tracked, ...extra].filter((d) => d.trim()).join('');
}

export async function resolveSha(repoPath: string, ref: string): Promise<string> {
  return (await git(repoPath, ['rev-parse', ref])).trim();
}

/** Paths changed between base and head (or working tree vs HEAD when head is null). */
export async function changedPaths(repoPath: string, baseRef: string, headRef: string | null): Promise<string[]> {
  const args = headRef
    ? ['diff', '--name-only', await effectiveBaseSha(repoPath, baseRef, headRef), headRef]
    : ['diff', '--name-only', 'HEAD'];
  const paths = (await git(repoPath, args)).split('\n').filter(Boolean);
  return headRef ? paths : [...paths, ...(await untrackedPaths(repoPath))];
}
