# Codocs

**Design docs that staff themselves.**

Codocs lets AI agents collaborate with you through Google Docs. Comment on your doc — agents read, think, edit, and reply. Each agent keeps a persistent session, so when you comment on their work, they pick up with full memory of what they built and why.

## How it works

1. You comment on a Google Doc — *"Add retry logic with exponential backoff"*
2. An agent is assigned based on who last worked on that section
3. The agent writes code, creates a PR, and updates the doc
4. A reply is posted — *"Done — PR #42 ready for review"*

## Features

- **Multi-agent collaboration** — Agents self-assign from comments based on who authored the quoted text. Each gets a unique name and color, with full attribution tracking via named ranges.
- **Rich Google Docs formatting** — Bidirectional Markdown-to-Google Docs conversion. Headings, lists, tables, code blocks, links — all preserved.
- **Session persistence** — Agents resume where they left off. SQLite-backed sessions, per-agent comment queues, and automatic crash recovery.
- **Real-time comment listening** — Google Cloud Pub/Sub integration for instant comment detection.
- **GitHub integration** — Agents create draft PRs via worktrees and link them in comment replies.
- **Interactive TUI** — Terminal dashboard showing agent status, activity log, and live stats.

## Install

```bash
npm install -g @codocs/cli
```

Or download a standalone binary from [Releases](https://github.com/gangeli/codocs/releases).

## Quick start

```bash
# Authenticate with Google (and optionally GitHub)
codocs auth login

# Start collaborating
codocs
```

On first run, you'll be prompted to create or open a Google Doc. Add a comment and watch the agent respond.

## Commands

### `codocs` / `codocs serve [docIds...]`

Start the agent harness — listens for comments and dispatches agents.

| Flag | Description |
|------|-------------|
| `--debug` | Verbose logging |
| `--no-tui` | Plain text output instead of interactive dashboard |
| `--agent-type <type>` | Agent runner (default: `claude`) |
| `--db-path <path>` | SQLite database location |
| `--fallback-agent <name>` | Default agent for unattributed text |
| `--service-account [path]` | Post replies from a service-account identity instead of your own. Optional path; defaults to `~/.local/share/codocs/service-account.json` (provisioned by `make infra`). Without this flag, replies come from your OAuth identity with a `🤖` prefix. |

### `codocs auth`

```bash
codocs auth login       # Authenticate with Google + GitHub
codocs auth login --github  # GitHub only
codocs auth status      # Check auth status
codocs auth logout      # Clear stored tokens
```

### `codocs read <docId>`

Read a Google Doc as markdown. Use `--agent <name>` to filter to a specific agent's content.

### `codocs sections <docId>`

List all attributed sections in a document.

### `codocs edit <docId> <section> [file]`

Replace content of an attributed section. Reads from file or stdin.

### `codocs insert <docId> [file]`

Insert a new attributed section. Requires `--agent <name>`. Use `--after <section>` to control position.

### `codocs comment <docId> <text>`

Add a comment to a document. Use `--quote <text>` to anchor it to specific text.

## Architecture

Codocs is a monorepo with three packages:

| Package | Description |
|---------|-------------|
| `@codocs/core` | Google Docs API client, markdown converter, agent orchestrator, event listener |
| `@codocs/db` | SQLite-backed session, queue, and settings stores |
| `@codocs/cli` | CLI commands and interactive terminal UI |

## Development

```bash
# Install dependencies
npm install

# Build all packages
make build

# Run tests
make test

# Type check
make typecheck

# Create local executable
make codocs
./codocs

# Build cross-platform binaries
make dist
```

## Prerequisites

- **Node.js 22+**
- **Claude Code** — agents use Claude Code as the default runner
- **Google account** — for Docs access (OAuth handled by `codocs auth login`)
- **GitHub account** (optional) — for PR creation

## License

[MIT](LICENSE)
