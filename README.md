# Margin

[![CI](https://github.com/cruslim/margin/actions/workflows/ci.yml/badge.svg)](https://github.com/cruslim/margin/actions/workflows/ci.yml)

Local AI code review with chat. Review branches and uncommitted changes before they leave your machine — nothing is ever pushed or posted anywhere; the only network traffic is the model API calls made through your existing `claude` login (plus any extra finders you configure).

<img  alt="Margin reviewing a branch: diff viewer with inline finding cards, file tree, and chat" src="https://github.com/user-attachments/assets/c8588c86-64ec-469b-97f6-80fd4a48f507" />

## Features

### Reviewing

- **Local refs, no PR required** — pick a branch (searchable, sorted by latest commit) against any base, or review your uncommitted working tree
- **Rebase-aware** — after rebasing onto `origin/main` the changeset still shows only your commits, even while local `main` is behind; branches already landed upstream are flagged `✓ merged` instead of coming up empty; git activity from your terminal is picked up when the window regains focus
- **Delta re-reviews** — "Review new changes" covers only commits since the last review, and falls back to a full review when a rebase orphans the delta point
- **Verifier pass** — an agentic session cross-examines every finding against the code and marks it verified/refuted/uncertain with reasons
- **Multi-model finders** — an OpenAI-compatible endpoint (GPT/Ollama/OpenRouter) and the CodeRabbit CLI can run alongside the Claude reviewer; findings are source-tagged, with a per-reviewer Agent-log filter
- **Dismissal memory** — dismissed findings are hidden and never re-reported (per-repo `dismissals.json`, restorable)
- **Generated files stay out of the way** — lockfiles, build output, snapshots, codegen and `@generated` files are tagged, dimmed, sorted last, and excluded from findings
- **Per-repo instructions** — your own rules per repository, edited in the app and stored app-side (or a committed `.margin/margin.md` for team-shared rules); injected into every review and comment thread
- **Reads the repo's Claude Code setup** — a committed `CLAUDE.md` and the skills under `.claude/skills/` are surfaced to every finder: agentic reviewers get a skill index and open a `SKILL.md` when it applies, single-shot finders get the bodies inlined. Nothing under `.claude/` is executed or loaded as settings, so repo hooks and MCP servers stay off
- **Export** — save a review as Markdown (summary, findings with verdicts and their threads, comment threads) to paste into a PR description or hand to a teammate

### Diff & chat

- **Split/unified diff viewer** with inline finding cards anchored to file/line, and a file list (tree or flat) with per-file finding and conversation indicators
- **Chat everywhere** — general session chat, per-finding threads, and GitHub-style line-anchored comment threads (hover a diff line, click +; works even before a review runs), all streamed live
- **Resolvable conversations** — mark a thread resolved to collapse it; the file list shows ongoing (blue) vs resolved (green) conversations

### Working with agents

- **Specialist agents** — define named subagents (e.g. `@security`, `@performance`) in settings and assign one to a comment thread; the reviewer delegates the thread to it (read-only tools, optional model override) and follow-ups stay with the same specialist
- **Propose fix** — the agent replies with a unified diff; applying it always shows the patch and asks first (`git apply --recount`)
- **Hand a thread to your own agent** — route a comment thread or review finding to whatever agent you're already running (Claude Code in a terminal, a CI job, a colleague) instead of Margin's read-only reviewer. It's brokered as plain files: the agent makes the change, writes a reply, and the thread picks it up — no blocking, no extra AI call. See [docs/agent-bridge.md](docs/agent-bridge.md)

### Interface

- **Model picker** — per-session default/fable/opus/sonnet/haiku for reviews and chat
- **Themes** — Tokyo Night (default), Graphite, Nord, Gruvbox, and Paper (light); duplicate any preset in settings to edit every color token with live preview
- **Stays out of your way** — remembers your last repo and branch across launches, and the sidebar collapses when you want the diff full-width

## Requirements

- macOS, Windows, or Linux (developed on macOS; the Windows and Linux installs follow the same flow but get less testing)
- Node 20+
- The [Claude Code](https://claude.com/claude-code) CLI installed and logged in — reviews run through your existing `claude` login via the Claude Agent SDK

## Install / run

```sh
npm install
npm run install-app    # builds and installs the app locally (unsigned)
```

The install destination depends on your platform:

| Platform | Installs to | Launch |
| --- | --- | --- |
| macOS | `~/Applications/Margin.app` | Spotlight / Launchpad |
| Windows | `%LOCALAPPDATA%\Programs\Margin` | `Margin.exe` in that folder (pin it to Start) |
| Linux | `~/.local/opt/margin`, launcher symlinked at `~/.local/bin/margin` | `margin` (make sure `~/.local/bin` is on your `PATH`) |

The app is unsigned, so the first launch may need a security override (macOS: right-click → Open, or approve it under System Settings → Privacy & Security; Windows: SmartScreen → "More info" → "Run anyway").

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

Data lives in Electron's per-user app directory — `~/Library/Application Support/margin` on macOS, `%APPDATA%\margin` on Windows, `~/.config/margin` on Linux:

```
<app data dir>/reviews/
  <repo-name>-<hash>/          # hash of repo path, so same-named repos don't collide
    repo.json                  # repo path, name, branches
    dismissals.json            # findings dismissed in this repo (never re-reported)
    instructions.md            # custom review instructions for this repo (optional, user-editable)
    <branch-slug>/             # one folder per reviewed branch ("working-tree" for uncommitted)
      session-<key>.json       # findings, summary, model, token usage, cost, transcript
      bridge-<key>/            # threads handed to your own agent: inbox/ (Margin writes),
                               # outbox/ (the agent writes), processed/ — created on first handoff
```

## Safety rules

- Agent tools are read-only (Bash/Edit/Write explicitly disallowed)
- Propose-fix always shows the patch and asks before `git apply`; never mutates the working copy silently
- No remotes, no push, no PR integration by design

## License

[MIT](LICENSE)
