# AgentWatch Bridge

[![npm](https://img.shields.io/npm/v/@agentwatch-ai/bridge)](https://www.npmjs.com/package/@agentwatch-ai/bridge)

A small, open-source telemetry bridge for Claude Code, OpenAI Codex and Cursor. It
sends turn context to your backend and lets the backend attribute provider usage to
Git branches and ticket keys. There is no model proxy, MITM or daemon.

## Quick start

Requires Node.js 20+ and a backend that accepts AgentWatch events and OTLP.

```bash
npm install -g @agentwatch-ai/bridge
agentwatch setup --endpoint https://backend.example.com
```

Setup detects installed agents and configures their user-level hooks. Restart Claude
Code or Codex to load the native OpenTelemetry settings. In Codex, run `/hooks` once
and trust the AgentWatch entries. Then verify the installation:

```bash
agentwatch doctor
agentwatch status
```

For a local backend demo:

```bash
git clone https://github.com/alexrepetskyi/agentwatch.git
cd agentwatch
npm install
npm run build
npm run example
```

## Data flow

The system produces exactly two product records:

- `turn.summary` comes from agent hooks and is sent to `POST <backend>/v1/events`.
  It contains one prompt→response turn with tools, files and Git context. Hook-created
  summaries have `usage_status: "pending"` or `"provisional"`.
- `llm.call` is one provider request. Claude Code and Codex send native OTLP directly
  to `<backend>/v1/otlp/v1/logs`; the backend normalizes completed requests into
  idempotent `llm.call` rows.

The backend joins calls to turns using provider session/turn identifiers, then uses
the exported `aggregateTurnUsage` helper to finalize `llm_calls`, tokens, cost and
per-agent usage. `llm.call` is the atomic usage ledger; never add its totals to the
finalized `turn.summary` totals.

Git branches are inspected locally. An uppercase key such as `PAY-142` in
`feature/PAY-142-refund` is emitted as ticket evidence; the Bridge does not call Jira
or Linear APIs.

### Backend requirements

- Accept `POST /v1/events` with `{ "events": [...] }`.
- Accept OTLP/HTTP on `/v1/otlp/v1/logs` and, when enabled, `traces` or `metrics`.
- Normalize completed OTLP log records with `normalizeOtlpLogs`.
- Durably upsert calls by `(provider, call_id)` before acknowledging OTLP.
- Finalize summaries only after a quiet period, watermark or session end.

## Supported agents

| Agent | Hooks | Native OTel |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | logs, traces, metrics |
| OpenAI Codex | `~/.codex/hooks.json` | logs, traces |
| Cursor | `~/.cursor/hooks.json` | not available |

Cursor currently exposes no token usage in hooks or transcripts, so its summaries
remain `usage_status: "pending"`. Cursor CLI currently emits only shell hook events;
IDE sessions provide the full hook surface.

Cloud agents can run committed `.cursor/hooks.json` hooks, but AgentWatch setup does
not configure cloud environments: it installs a local user hook, and cloud VMs do not
have the AgentWatch binary automatically. Cloud use requires an explicit project hook
and installing the package in the cloud environment.

AgentWatch records accepted Tab edits through `afterTabFileEdit`. It deliberately does
not register `beforeTabFileRead`, which fires for every suggestion and carries file
content.

## Commands

```bash
agentwatch setup        # configure detected agents
agentwatch status       # backend, repository, agents and queue
agentwatch doctor       # diagnostics; add --json for machine output
agentwatch config       # effective config with secrets redacted
agentwatch uninstall    # remove AgentWatch-owned config; add --purge for local data
```

Setup preserves existing hooks, is idempotent and creates timestamped backups before
changing agent configuration. Foreign telemetry configuration is reported as a
conflict and is never overwritten.

## Configuration

Global configuration lives in `~/.agentwatch/config.json`. A repository may commit a
`.agentwatch.json` file to reduce content capture for that repository:

```json
{
  "capture": {
    "responses": false,
    "toolOutput": false
  }
}
```

Prompts, responses, tool input/output, Git and file capture are enabled by default.
Repository config may override only capture settings; endpoint, token, identity,
delivery, emission and OTel signal selection remain machine-global.

Use `agentwatch setup --otel <signals>` with `all`, `none` or a comma list such as
`logs,traces`. The default is `logs`, which carries the per-request usage ledger.

## Privacy and reliability

- Hook-derived records pass through recursive secret redaction before delivery.
- Native OTLP goes directly from Claude Code or Codex to your backend and does not pass
  through the Bridge sanitizer. AgentWatch does not enable provider options that add
  raw prompts or tool content to native OTel.
- Disabled prompt/response capture retains only `{length, sha256}` evidence. Disabled
  tool, Git and file categories are omitted.
- Failed hook deliveries enter a bounded local queue with backoff. A 60-second circuit
  breaker avoids repeated waits while the backend is unavailable.

## Backend helpers

The package ships JavaScript and TypeScript declarations for its public helpers:

```ts
import type { ProductEvent } from '@agentwatch-ai/bridge/events';
import { normalizeOtlpLogs } from '@agentwatch-ai/bridge/otlp';
import { aggregateTurnUsage } from '@agentwatch-ai/bridge/aggregate-turn';
```

## Links

- GitHub: <https://github.com/alexrepetskyi/agentwatch>
- npm: <https://www.npmjs.com/package/@agentwatch-ai/bridge>
- Issues: <https://github.com/alexrepetskyi/agentwatch/issues>

## License

MIT — see [LICENSE](LICENSE). Inspired by ideas from
[o11y-dev/opentelemetry-hooks](https://github.com/o11y-dev/opentelemetry-hooks) (MIT);
this project is an independent TypeScript implementation.
