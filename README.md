# Margin

[![CI](https://github.com/cruslim/margin/actions/workflows/ci.yml/badge.svg)](https://github.com/cruslim/margin/actions/workflows/ci.yml)

Local AI code review with chat. Review branches and uncommitted changes before they leave your machine — nothing is ever pushed or posted anywhere; the only network traffic is the model API calls made through your existing `claude` login (plus any extra finders you configure).

## Features

- **Reviews of local refs** — pick a branch (searchable, sorted by latest commit) vs any base, or your uncommitted working tree; no remote, no PR required
- **Split/unified diff viewer** with inline finding cards anchored to file/line, and a file list (tree or flat) with per-file finding and conversation indicators
- **Chat** — general session chat, per-finding threads, and GitHub-style line-anchored comment threads (hover a diff line, click +; works even before a review runs), all streamed live with copyable replies
- **Resolvable conversations** — mark a comment thread resolved to collapse it; the file list shows which files have ongoing (blue) vs fully resolved (green) conversations
- **Propose fix** — the agent replies with a unified diff; applying it always shows the patch and asks first (`git apply --recount`)
- **Multi-model finders** — an OpenAI-compatible endpoint (GPT/Ollama/OpenRouter) and the CodeRabbit CLI can run in parallel with the Claude reviewer; findings are source-tagged with a per-reviewer Agent-log filter
- **Verifier pass** — an agentic session cross-examines every finding against the code and marks it verified/refuted/uncertain with reasons
- **Delta re-reviews** — "Review new changes" covers only commits since the last review
- **Dismissal memory** — dismissed findings are hidden and never re-reported (per-repo `dismissals.json`, restorable)
- **Generated files stay out of the way** — lockfiles, build output, snapshots, codegen, static-analysis baselines (mago/phpstan/psalm) and `@generated` banners are tagged `auto-generated`, dimmed and sorted last, and the reviewers are told not to report findings in them
- **Per-repo instructions** — your own rules per repository, edited in the app (✎ on the repo row) and stored app-side, so the repo stays clean and they're deleted with the repo; a committed `.margin/margin.md` works too for team-shared rules. Both are injected into every review and into comment threads started before a review
- **Model picker** — per-session default/fable/opus/sonnet/haiku for reviews and chat

## Requirements

- macOS (packaging targets mac; `npm run dev` may work elsewhere but is untested)
- Node 20+
- The [Claude Code](https://claude.com/claude-code) CLI installed and logged in — Margin reviews run through your existing `claude` login via the Claude Agent SDK

## Install / run

```sh
npm install
npm run package        # builds dist/mac-arm64/Margin.app (unsigned, local use)
ditto dist/mac-arm64/Margin.app ~/Applications/Margin.app
```

## Development

```sh
npm run dev        # run the app with hot reload
npm test           # unit tests (vitest)
npm run typecheck  # tsc --noEmit
```

CI runs typecheck, tests, and a build on every PR and push to master.

## Try the engine from the CLI

```sh
# Review a branch against main
npm run review -- /path/to/repo --base main --head feature/my-branch

# Review uncommitted changes
npm run review -- /path/to/repo --working

# Ask a follow-up about the last review (same session, full context)
npm run chat -- "Propose a fix for finding 1"
```

## Architecture

- **Electron + TypeScript everywhere** — the main process is the backend, React in the renderer
- **Review engine** (`src/engine/`): creates a detached temp git worktree per session so the agent reads a stable snapshot and never touches your working copy; runs the Claude Agent SDK with tools restricted to Read/Grep/Glob; the agent verifies each suspicion against the codebase before reporting; emits findings as JSON anchored to file/line with an exact snippet for re-anchoring in the diff viewer
- **Chat** (`src/engine/chat.ts`): resumes the review session by ID — the agent keeps everything it read and found. Worktrees stay alive until a session is closed so chat can keep reading files
- **Persistence** (`src/main/storage.ts`): plain JSON files, human-readable, all local — no database

```
~/Library/Application Support/margin/reviews/
  <repo-name>-<hash>/          # hash of repo path, so same-named repos don't collide
    repo.json                  # repo path, name, branches
    dismissals.json            # findings dismissed in this repo (never re-reported)
    instructions.md            # custom review instructions for this repo (optional, user-editable)
    <branch-slug>/             # one folder per reviewed branch ("working-tree" for uncommitted)
      session-<key>.json       # findings, summary, model, token usage, cost, transcript
```

## Safety rules

- Agent tools are read-only (Bash/Edit/Write explicitly disallowed)
- Propose-fix always shows the patch and asks before `git apply`; never mutates the working copy silently
- No remotes, no push, no PR integration by design

## Screenshot
<img width="2115" height="1289" alt="image" src="https://github.com/user-attachments/assets/c8588c86-64ec-469b-97f6-80fd4a48f507" />


## Roadmap

- [ ] Agent bridge, step 1: live `.margin/review.md` export — open findings and unresolved
      conversations written into the repo so a coding agent (e.g. Claude Code working on the same
      branch) can pick them up ([design](docs/agent-bridge.md))
- [ ] Agent bridge, step 2: MCP server — the coding agent reads threads, replies into them, and
      resolves them from its side ([design](docs/agent-bridge.md))
- [ ] Per-finder findings streaming
- [ ] Multiple saved providers

## License

[MIT](LICENSE)
