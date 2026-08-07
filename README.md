# AgentWatch Bridge

A lightweight, open-source telemetry bridge for AI coding agents. It connects the agents you
already use (Claude Code, OpenAI Codex) to *your* backend, with no proxy, no MITM, no daemon.

```bash
npm install -g @agentwatch/bridge
agentwatch setup
```

## What it does

AgentWatch Bridge combines two native telemetry sources that solve different problems:

1. **Native agent hooks** → development context. Each agent invokes
   `agentwatch hook --agent <id>` on lifecycle events (session, prompt, tool, shell, MCP, file
   edits, subagents). The short-lived hook process normalizes the event into a canonical schema,
   enriches it with Git context (repository, branch, commit, changed files, ticket-key evidence
   from the branch name), sanitizes it, and delivers it to `POST <backend>/v1/events`.
2. **Native agent OpenTelemetry** → authoritative usage data. `agentwatch setup` configures each
   agent's *own* OTel exporter (tokens, cost, model, per-request metrics) to send OTLP directly
   to your backend. The Bridge never re-estimates token usage from text.

Both streams carry the same provider session identifiers (Claude `session.id`, Codex
`conversation.id`), so your backend can join hook lifecycle + usage + Git/feature evidence
downstream.

```
Claude Code / Codex ── native hook ──> agentwatch hook ──> normalize + git + sanitize ──> /v1/events
Claude Code / Codex ── native OTel ─────────────────────────────────────────────────────> /v1/otlp/...
```

## Supported agents

| Agent | Hooks | Native OTel |
|---|---|---|
| Claude Code | ✅ `~/.claude/settings.json` | ✅ env block (`CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_*`) |
| OpenAI Codex | ✅ `~/.codex/hooks.json` | ✅ `[otel]` in `~/.codex/config.toml` |
| Cursor / Gemini CLI / Copilot / OpenCode / Windsurf | planned (adapter interface is ready) |

> **Codex note:** Codex requires you to trust newly installed hooks. After setup, run `codex`,
> type `/hooks`, and trust the AgentWatch entries.

## Installation & setup

```bash
npm install -g @agentwatch/bridge
agentwatch setup                     # interactive: asks for your backend URL
agentwatch setup --endpoint https://backend.example.com --token <token> --yes   # non-interactive
```

Setup:

- detects your Git repository (works fine outside one too),
- detects installed agents (config dirs + executables),
- stores configuration in `~/.agentwatch/config.json` (never in your repo),
- registers hooks by **merging** into each agent's config — existing hooks are preserved, running
  setup twice changes nothing, and every modified file gets a timestamped backup first,
- configures each agent's native OTel exporter, skipping (never overwriting) any telemetry
  configuration you already have.

## Backend endpoints

Any compatible backend works — nothing is hardcoded:

- Hook events: `POST <endpoint>/v1/events` with `{"events": [...]}` and optional
  `Authorization: Bearer <token>`.
- Native OTel: agents export OTLP/HTTP to `<endpoint>/v1/otlp` (standard signal paths are
  appended, e.g. `/v1/otlp/v1/metrics`, `/v1/otlp/v1/logs`).
- Both URLs are independently overridable via `eventsUrl` / `otlpUrl` in
  `~/.agentwatch/config.json`.

## Privacy model

**Metadata-only by default.** Out of the box, AgentWatch sends:

- event types, timestamps, session/turn/tool identifiers, tool names, durations, status
- model names; token counts via native OTel
- repository name, hashed remote, branch, commit, repo-relative changed-file paths

It does **not** send: prompt text, response text, tool inputs/outputs, file contents, environment
variables, or absolute paths (working dir and file paths are repo-relative). Prompt/response
bodies are represented only as `{length, sha256}` evidence. Opt in per category in
`~/.agentwatch/config.json`:

```json
{
  "capture": { "prompts": false, "responses": false, "toolInput": false, "toolOutput": false, "git": true, "files": true }
}
```

Everything that leaves the machine passes a recursive secret sanitizer (API keys, bearer tokens,
GitHub/AWS/Slack tokens, JWTs, private keys, URL-embedded credentials, password assignments).
Git remote URLs are stripped of credentials and also reported as a SHA-256 hash.

## Reliability

- Hooks respond to the agent immediately (exit 0, silent stdout) and never block it: direct
  delivery uses a ~1.5 s budget; failures persist events to a bounded local queue
  (`~/.local/share/agentwatch/queue`), retried with exponential backoff on future hook
  invocations and by `agentwatch status`.
- Deterministic event IDs make delivery idempotent.
- A completely dead backend costs your coding agent nothing.

## Commands

```bash
agentwatch setup        # detect agents, configure hooks + native OTel
agentwatch status       # backend, repo, per-agent hook/OTel state, queue health
agentwatch doctor       # full diagnostics (--json for machines); never prints secrets
agentwatch uninstall    # remove ONLY AgentWatch-owned config (--agent <id>, --purge)
agentwatch agents       # detection details
agentwatch config       # sanitized config dump
agentwatch hook --agent <id> [--dry-run]   # invoked by agents; reads JSON on stdin
```

Debugging: `AGENTWATCH_DEBUG=1` or `--verbose` (diagnostics go to stderr, never stdout).

## Uninstall

```bash
agentwatch uninstall            # removes AgentWatch hooks + OTel config from all agents
agentwatch uninstall --purge    # also removes ~/.agentwatch and queued data
npm uninstall -g @agentwatch/bridge
```

Uninstall removes only entries AgentWatch created (tracked in
`~/.agentwatch/install-state.json`); your own hooks and telemetry settings are untouched.

## Troubleshooting

- `agentwatch doctor` first. It checks Node version, config, backend connectivity, agent
  detection, hook registration, native OTel state, git availability, queue health and
  write permissions.
- Codex hooks not firing? Run `codex` → `/hooks` → trust the AgentWatch hook. Also check that
  `~/.codex/config.toml` doesn't set `[features] hooks = false`.
- Claude OTel not exporting? Restart Claude Code sessions after setup; env changes apply at start.
- Events piling up? `agentwatch status` shows the backlog and retries it when the backend is back.

## Design notes

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Provider behavior is verified against the
agents' official docs/source as of 2026-08; provider APIs move fast — `doctor` is the safety net.
Architecture ideas were inspired by
[o11y-dev/opentelemetry-hooks](https://github.com/o11y-dev/opentelemetry-hooks) (MIT); this
project is an independent TypeScript implementation.

## License

MIT — see [LICENSE](LICENSE).
