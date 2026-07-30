# Agent bridge — feeding Margin reviews to a coding agent

## Use case

You're working on a branch with a coding agent (Claude Code in a terminal) while
reviewing the same changes in Margin. Findings pile up, comment threads happen —
and the agent doing the work should pick them up and address them, without you
copy-pasting between windows.

Two designs, intended to ship in order: the file bridge first, MCP as the
follow-up that completes the loop. They share the same item IDs, so nothing
about A is throwaway.

## Option A — live review file (`.margin/review.md`)

Margin writes a snapshot of the review into the working copy of the repo under
its existing `.margin/` directory, debounced on every change to findings or
comment threads (same pattern as session persistence in `App.tsx`).

**Contents**

- Change summary from the last review
- Open findings: everything not dismissed and not verifier-refuted, with
  `file:line`, severity, category, summary, failure scenario, and snippet
- Unresolved comment threads: full conversation per thread, with file/line
  anchor — threads marked resolved in the UI are omitted, so **resolving is the
  "done" signal** and the file always reflects only outstanding work
- A stable ID per item (finding key / comment UUID), so an agent can reference
  items unambiguously and so the IDs carry over to Option B

**Format sketch**

```markdown
# Margin review — feat/my-branch vs main (updated 2026-07-30T10:12:00Z)

## Change summary
<one paragraph>

## Open findings
### [f-3a91c2] HIGH correctness — src/cart.ts:42
Off-by-one skips the last item.
Failure: checkout with 3 items charges for 2.
> for (let i = 0; i < items.length - 1; i++)

## Open conversations
### [c-7bd0…] src/api/auth.ts:118 (new side)
**user:** why isn't this rate-limited?
**margin:** The login endpoint has no limiter middleware; …
```

**Workflow**

1. Review in Margin (typically an "uncommitted changes" session while the agent
   works on the same checkout).
2. Tell the coding agent — once, e.g. in `CLAUDE.md`: *"If `.margin/review.md`
   exists, read it and address the open items."*
3. The agent's edits land in the working tree, so they show up in Margin's
   working-tree diff; verify there, resolve the thread, and the file updates.

**Details / limitations**

- The file must be gitignored (`.margin/` or `.margin/review.md`); Margin warns
  when it isn't rather than editing `.gitignore` itself.
- Written to the *user's repo path*, not the session worktree — the point is
  the agent working in the real checkout. Branch-review sessions export too,
  but the working-tree session is the primary use case.
- One file per repo; if several sessions target the same repo, the active
  session wins (last write).
- One-way by design: the agent cannot reply into threads or resolve them —
  that's Option B. (A cheap interim: the agent leaves a note per item in its
  commit/summary; the human resolves in Margin.)

## Option B — Margin as an MCP server

The Electron main process serves MCP over HTTP on localhost. One-time setup per
machine: `claude mcp add --transport http margin http://localhost:<port>/mcp`.
Any MCP-capable agent then gets the review as tools:

| Tool | Effect |
| --- | --- |
| `list_open_items(repoPath)` | Open findings + unresolved threads (same IDs as the review file) |
| `get_thread(id)` | Full conversation for one finding/comment thread |
| `reply_to_thread(id, text)` | Appends a message into the Margin thread — visible in the UI |
| `resolve_thread(id)` | Marks the conversation resolved (blue dot → green, live) |

This completes the loop the file bridge leaves open: the working agent's
replies land inside Margin's comment threads, and it can mark its own work
resolved while you watch.

**Details to settle when building**

- Port management (fixed default + settings override), and advertising the URL
  in the UI for the `claude mcp add` one-liner
- Repo scoping: tools take a repo path and resolve to the matching session
  (active session wins on ambiguity, as in Option A)
- Writes go through the same code paths as the UI (append message / toggle
  resolved) so persistence and indicators stay consistent
- Auth: localhost-only binding; no remote exposure, consistent with Margin's
  no-server philosophy

## Sequencing

1. **A ships first** — small, offline, agent-agnostic; immediately serves the
   "agent picks up the review" workflow.
2. **B builds on A** — same IDs, same open/resolved semantics; adds write-back.
   The review file stays useful afterwards for agents without MCP.
