# Agent bridge — feeding Margin reviews to a coding agent

## Use case

You're working on a branch with a coding agent (Claude Code in a terminal) while
reviewing the same changes in Margin. Comment threads happen, findings pile up —
and the agent doing the work should pick them up and address them, without you
copy-pasting between windows.

Margin's own reviewer can't do it: it is read-only by design (`Bash`/`Edit`/`Write`
are disallowed, and even specialist subagents get `tools: ['Read','Grep','Glob']`).
So the bridge points the other way — comments out to an agent that *can* write, and
the change back into the diff.

Step 1 ships as **external agent mode**. Step 2, MCP, completes the loop for
agents that speak it. They share the same open/resolved semantics and the same
comment ids, so nothing about step 1 is throwaway.

## Step 1 — handing threads to your agent (shipped)

Not a mode. Answering is a property of a **thread**, chosen in the composer's
existing picker — the same one that routes a thread to `@security` — which now
offers `↗ my agent` alongside Margin's own reviewer and the specialists. It is
labelled "answered by", not "reviewer" — the person using Margin is the reviewer:

```
answered by [ ↗ my agent ▾ ]  ⧉ copy prompt
   └ default / @security / @performance / ↗ my agent
[ Comment on the selected lines — sends to your agent…  ]
Comment on lines 22 – 27                   Cancel  Comment
```

Who answers goes above the box, because it's a decision you make before typing;
the line range sits below with the buttons, as context rather than a control. The
prompt to brief your agent with appears beside the picker the moment you choose
the handoff — and only there. A copy of it in the topbar was tried and removed:
with no picker next to it, nothing said what the prompt was for.

Which option a fresh composer starts on is **Settings → Agents → "New comment
threads go to"** (`defaultAnswerer` in settings.json: `reviewer`, `my-agent`, or a
specialist's name), so a session spent handing everything to your agent doesn't
mean re-choosing per comment. A name that no longer matches a configured
specialist falls back to the reviewer.

An already-answered thread can be handed over later with **↗ hand to my agent**
next to *Reply*, which is the flow worth having: Margin's reviewer explains the
problem, then your agent goes and fixes it. Either way the thread keeps its
answerer, so replies continue to the same place — exactly how specialist threads
already behave.

Scoping falls out of this for free: only comment *threads* are ever brokered.
Reviews, session chat, finding threads and Propose fix stay with Margin's own
reviewer and its model picker, and nothing in the UI implies otherwise.

```
you hand a thread over
  └─► Margin writes  <bridge>/inbox/<comment-id>--<turn>.md
        no AI call is made
           └─► your agent reads it, edits the repo, writes
                 <bridge>/outbox/<comment-id>--<turn>.md
                    └─► Margin polls, appends the text to the thread,
                        and moves both halves to processed/
```

Then hit **↻** on the branch row: the diff refreshes over the agent's edits and
the thread re-anchors to the line's new position. The code coming back is the
point; the text reply is confirmation.

**Where the files live.** Beside the session JSON in app data, not in the repo:

```
~/Library/Application Support/margin/reviews/<repo-slug>/<branch-slug>/bridge-<session-key>/
  README.md     # the protocol, written fresh on every exchange
  inbox/        # Margin writes — anything here is unanswered
  outbox/       # the agent writes — same basename as the item it answers
  processed/    # <item>.request.md + <item>.reply.md, once delivered
```

Keeping it out of the working copy means no gitignore rules and no bridge churn
in the very diff you're reviewing. The cost — the agent has to be told where to
look — is covered by **copy prompt** in the composer, which yields a paste-ready
sentence naming the absolute path and asking the agent to keep picking items up
rather than treating the inbox as a one-off. Every inbox file also carries a
`reply_to:` absolute path, so the agent never has to derive the layout.

Briefing is per agent session, not per comment: once your agent knows the path,
every later comment lands in the same `inbox/`. To brief a *new* agent session,
open a composer and choose `↗ my agent` again.

**Design points**

- **One writer per file.** Margin owns `inbox/`, the agent owns `outbox/`.
  Nothing is a shared file, so there is nothing to conflict over — which matters
  because Margin re-saves each session from memory ~400ms after any state change
  and would otherwise clobber an external write.
- **Nothing blocks.** Margin writes the request and returns; replies land
  whenever they land. Busy state is per *session*, so awaiting a reply would have
  frozen the whole session's chat behind an agent that may take minutes.
- **Pending state is recorded on the thread** (`pendingTurn`), not derived from
  whether the last message is the reviewer's — because a thread can be handed
  over immediately after Margin answered it, and then "last word is the
  reviewer's" is simply false while a request is out. It lives in the session
  JSON, so a thread left out overnight is still pending after a restart, and the
  first poll tick after launch delivers anything written while Margin was closed.
- **Polling follows pending work.** Only sessions with an outstanding request are
  watched, so an app with nothing out polls nothing.
- **One item per turn.** A reply on an answered thread brokers
  `<comment-id>--<turn>`, so follow-ups queue instead of overwriting.
- **Withdrawable.** "Stop waiting" moves the request out of `inbox/`, keeping the
  agent's work list truthful, and deleting a thread withdraws its request too.
- **Free.** Margin fires an AI turn the moment a comment is created, so normally
  every comment costs a call. A handed-off thread spends nothing.

**Findings too.** A review finding has the same *↗ hand to my agent* action beside
Reply / Propose fix, so the agent can fix what Margin found without you restating
it. The item is tagged `kind: finding` and carries the severity, category, summary
and failure scenario, and it explicitly invites disagreement rather than assuming
the finding is right. Findings are identified by a hash of file + category +
summary (`f-…`, see `shared/findingItem.ts`) rather than their index: a re-review
reorders findings, and an index captured while a request was out would deliver the
reply onto a different one.

**Limitations**

- The agent can't resolve threads or dismiss findings from its side — that's step 2.
- One bridge per session; two sessions on the same branch get their own
  directories and neither sees the other's items.
- Nothing is pushed: the agent only ever sees what you hand over, one item at a
  time. A bulk export of the whole open-findings list is still the follow-up below.

## Step 2 — Margin as an MCP server

The Electron main process serves MCP over HTTP on localhost. One-time setup per
machine: `claude mcp add --transport http margin http://localhost:<port>/mcp`.
Any MCP-capable agent then gets the review as tools:

| Tool | Effect |
| --- | --- |
| `list_open_items(repoPath)` | Open findings + unresolved threads |
| `get_thread(id)` | Full conversation for one finding/comment thread |
| `reply_to_thread(id, text)` | Appends a message into the Margin thread — visible in the UI |
| `resolve_thread(id)` | Marks the conversation resolved (blue dot → green, live) |

What this adds over step 1: findings as well as comments, replies into *finding*
threads, and the agent marking its own work resolved while you watch. The file
bridge stays useful afterwards for agents without MCP.

**Details to settle when building**

- Port management (fixed default + settings override), and advertising the URL
  in the UI for the `claude mcp add` one-liner
- Repo scoping: tools take a repo path and resolve to the matching session
  (active session wins on ambiguity)
- Writes go through the same code paths as the UI (append message / toggle
  resolved) so persistence and indicators stay consistent
- Auth: localhost-only binding; no remote exposure, consistent with Margin's
  no-server philosophy

## Follow-up — open findings over the bridge

External mode brokers comments only. The same directory can carry a debounced
`findings.md` snapshot of everything un-dismissed and un-refuted, with
`file:line`, severity, category, and snippet per item — so an agent can work the
review list, not just the questions. Resolving/dismissing in the UI is the "done"
signal, exactly as it is for threads.

## Rejected

- **Sharing the SDK session** (`resume` / `forkSession`). Wrong direction: it
  gives Margin's agent the coding session's *history*, not the coding agent the
  *comments* — and Margin's agent still couldn't write. Two processes resuming one
  session id would also conflict.
- **Both agents writing the session JSON** (watch-and-merge). Margin re-saves the
  whole session from memory after any state change and reads state exactly once at
  mount, so an external write is invisible until restart and then overwritten.
- **An `author` field on messages.** Only needed if two agents can answer one
  thread. A thread has exactly one answerer, so `role` already covers it.
- **A session-wide "external mode"** with a topbar toggle. Built first, then
  removed: it read as though the whole session had been handed over when only
  comments were, so it needed labels and tooltips to explain a scope that a
  per-thread choice states by construction. It also couldn't express the useful
  case — Margin answers, *then* the agent implements — and it put the control far
  from the composer where the decision is actually made.
- **Per-thread mode locks and restart-on-switch.** Both guarded the cosmetic case
  of a thread with two assistant voices after a mid-session flip — and the restart
  rule put a wall exactly where you'd most want to switch, after paying for a
  review. The answerer is free to change at any time.
