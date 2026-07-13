# Margin

Local AI code review with chat. Review branches and uncommitted changes before they leave your machine — nothing is ever pushed or posted anywhere; the only network traffic is the Claude API calls made through your existing `claude` login.

## Status

Milestone 1 (review engine spike) — **done and verified**.

- [x] M1 — Engine: worktree-per-session, Claude Agent SDK review with read-only tools, structured JSON findings, session resume for chat
- [x] M2 — Electron app shell: repo picker, session list, split/unified diff viewer for local refs (`npm run dev`)
- [x] M3 — Review pipeline wired to UI: streamed agent transcript, findings panel, inline finding cards anchored in the diff
- [x] M4 — Chat: finding-level threads, general chat tab, propose-fix with `git apply --recount` + confirm
- [x] Comments — GitHub-style line-anchored AI threads: hover a diff line, click +, comment (with from-line range control); works even before a review runs
- [x] Streaming replies — chat/comment answers render live as they generate
- [x] Model picker — per-session default/sonnet/opus/haiku for reviews and chat
- [x] Delta re-reviews — "Review new changes" covers only commits since the last review
- [x] Dismissal memory — dismissed findings hidden and never re-reported (per-repo `dismissals.json`, restorable)
- [x] `.margin.md` — per-repo review instructions injected into every review
- [ ] M5 remainder: multi-lens finder/verifier pipeline, markdown export, packaging (`electron-builder`)

## Storage

Plain JSON files, human-readable, all local — no database:

```
~/Library/Application Support/margin/reviews/
  <repo-name>-<hash>/          # hash of repo path, so same-named repos don't collide
    repo.json                  # repo path, name, branches
    <branch-slug>/             # one folder per reviewed branch ("working-tree" for uncommitted)
      session-<key>.json       # findings, summary, model, token usage, cost, transcript
```

## Install / run

```sh
npm run package        # builds dist/mac-arm64/Margin.app (unsigned, local use)
ditto dist/mac-arm64/Margin.app ~/Applications/Margin.app
```

Or for development: `npm run dev`.

## Try the engine

```sh
# Review a branch against main
npm run review -- /path/to/repo --base main --head feature/my-branch

# Review uncommitted changes
npm run review -- /path/to/repo --working

# Ask a follow-up about the last review (same session, full context)
npm run chat -- "Propose a fix for finding 1"
```

## Architecture

- **Electron + TypeScript everywhere** (main process = backend; React renderer to come)
- **Review engine** (`src/engine/`): creates a detached temp git worktree per session so the agent reads a stable snapshot and never touches your working copy; runs the Claude Agent SDK with tools restricted to Read/Grep/Glob; the agent verifies each suspicion against the codebase before reporting; emits findings as JSON anchored to file/line with an exact snippet for re-anchoring in the diff viewer
- **Chat** (`src/engine/chat.ts`): resumes the review session by ID — the agent keeps everything it read and found. Worktrees stay alive until a session is closed so chat can keep reading files
- **Persistence** (`src/main/storage.ts`): JSON files, folder per repo / per branch (see Storage below)

## Safety rules

- Agent tools are read-only (Bash/Edit/Write explicitly disallowed)
- Propose-fix always shows the patch and asks before `git apply`; never mutates the working copy silently
- No remotes, no push, no PR integration by design
