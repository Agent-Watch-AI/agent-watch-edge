# AgentWatch Bridge

A lightweight, open-source telemetry bridge for AI coding agents. It connects Claude Code and
OpenAI Codex to *your* backend and correlates native token costs with turns, Git branches and
Jira tickets — with no proxy, no MITM and no daemon.

```bash
npm install -g @agentwatch/bridge
agentwatch setup
```

## Quick start

AgentWatch requires Node.js 20+ and an AgentWatch-compatible events/OTLP backend:

```bash
npm install -g @agentwatch/bridge
agentwatch setup --endpoint https://backend.example.com
```

Restart Claude Code or Codex so it picks up the native OTel configuration. For Codex, run
`/hooks` once and trust the AgentWatch entries. Then verify the installation:

```bash
agentwatch doctor
agentwatch status
```

To try the bridge without a production backend, clone this repository and run `npm install`,
`npm run build`, then `npm run example`. See [example/README.md](example/README.md) for the
end-to-end local setup.

## What it does

AgentWatch Bridge combines two native telemetry sources into exactly two product records:
`llm.call` and `turn.summary`.

1. **Native agent hooks** → development context. Each agent invokes
   `agentwatch hook --agent <id>` on lifecycle events (session, prompt, tool, shell, MCP, file
   edits, subagents). These lifecycle events stay local and are assembled into one
   `turn.summary`, enriched with Git/branch/ticket context, sanitized, and delivered to
   `POST <backend>/v1/events`.
2. **Native agent OpenTelemetry** → one `llm.call` per provider request. `agentwatch setup`
   configures metrics, logs and traces. The backend normalizes request/completion logs into the
   atomic usage ledger and uses trace/thread/agent identifiers to retain main-agent and
   subagent attribution.

Both streams carry provider session and turn identifiers. The backend joins each call to its
turn and copies the turn's repository, branch and ticket evidence onto the call.

`llm.call` is the source of truth for tokens and cost. `turn.summary` is a materialized aggregate
of unique calls for one prompt→final-response turn. Never sum summaries and calls together.

Notes on precision:

- Turn correlation via `prompt_id` requires **Claude Code >= 2.1.196** (`agentwatch doctor`
  checks this). On older versions `turn_id` is empty and turn tracking degrades to
  session-scoped.
- Claude transcript totals initially attached by the hook are provisional. The backend replaces
  them with the sum of unique `llm.call` records and changes `usage_status` to `complete`.
- Lossless accounting requires a durable OTLP receiver. Setup now fails when it cannot install
  the native exporter, and `doctor` treats a missing exporter as a failure. The receiver must
  durably persist OTLP before acknowledging it and upsert calls by `(provider, call_id)` so
  exporter retries cannot duplicate usage.
- `files_changed` is the dirty working tree at Stop (not a per-turn diff); `files_touched`
  only sees tools that report an explicit file path.

```
Claude Code / Codex ── hooks ──> local turn assembly ──> turn.summary ────────────────> /v1/events
Claude Code / Codex ── OTel metrics + logs + traces ──> correlate ──> llm.call ───────> durable ledger
```

## Feature cost attribution

AgentWatch provides the telemetry foundation for measuring direct LLM spend by feature:

```text
llm.call → turn → Git branch / Jira ticket → feature → SUM(cost_usd)
```

For example, calls made while working on `feature/PAY-142-*` can be attributed to `PAY-142`.
The backend joins `llm.call` and `turn.summary` by `session_id + turn_id`, copies the turn's
branch and ticket evidence onto each call, and sums deduplicated `llm.call.cost_usd` values.
Do not add `turn.summary.cost_usd` to that total: it is a materialized aggregate of the same
calls.

The package supplies collection, correlation fields, schemas and backend helpers; it is not a
hosted analytics product. A production implementation still needs durable OTLP storage,
session/turn correlation, ticket-to-feature mapping, attribution rules for untracked or shared
work, and reporting by feature, developer, model and time period.

This measures direct LLM usage cost, not total engineering cost. Salaries, developer time, CI
and infrastructure are outside the package's scope.

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
- stores configuration in `~/.agentwatch/config.json`,
- registers hooks by **merging** into each agent's config — existing hooks are preserved, running
  setup twice changes nothing, and every modified file gets a timestamped backup first,
- configures each agent's native OTel exporter, skipping (never overwriting) any telemetry
  configuration you already have.

## Product records

The public contract contains exactly two event types. Hook lifecycle events such as tool,
session, prompt and subagent start/stop are internal and never leave through `/v1/events`.

### `llm.call`

One physical provider request/completion, including calls made by child agents:

```json
{
  "schemaVersion": "1",
  "event": { "type": "llm.call", "providerEventType": "llm.call" },
  "provider": "claude-code",
  "call_id": "req_011...",
  "session_id": "…", "turn_id": "…",
  "agent_id": "agent-77", "parent_agent_id": "main", "agent_type": "Explore",
  "model": "claude-sonnet-4-6", "status": "completed", "correlation": "turn",
  "input_tokens": 12000, "cached_input_tokens": 10000, "output_tokens": 350,
  "cost_usd": 0.042, "duration_ms": 1840,
  "repository": "billing-service", "branch": "feature/PAY-142", "jira_ids": ["PAY-142"],
  "ended_at": "2026-08-07T18:01:02Z"
}
```

The backend must upsert by `(provider, call_id)`. A trace/spawn join may map a child's native
scope to the root product `session_id`/`turn_id`; when it does, the original values remain in
`provider_session_id`/`provider_turn_id`. For Codex a child `thread.id` is a stable agent
identity and multi-agent spawn telemetry supplies the parent link. For Claude,
`query_source` identifies main/subagent origin and enhanced `llm_request` traces add `agent_id`
when the provider exposes it. Missing instance identity does not drop tokens: the call remains
in the turn total and is grouped under its provider agent type or `unattributed`.

### `turn.summary`

Every prompt→response turn produces a `turn.summary` on `Stop`. The hook sends context first;
the backend then finalizes usage from its call ledger:

```json
{
  "schemaVersion": "1",
  "event": { "type": "turn.summary", "providerEventType": "turn.summary" },
  "provider": "claude-code",
  "surface": "cli",
  "session_id": "…", "turn_id": "…",
  "developer_id": "dev@company.com",
  "repository": "billing-service", "branch": "feature/PAY-142", "commit": "abc123",
  "jira_ids": ["PAY-142"],
  "files_changed": ["src/payments/refund.ts"],
  "files_touched": ["src/payments/refund.ts"],
  "prompt": "…", "response": "…",
  "tool_calls": 18, "tools_used": { "Bash": 5, "Edit": 9, "Read": 4 },
  "model": "claude-sonnet-4",
  "llm_calls": 4,
  "input_tokens": 14500, "cached_input_tokens": 8000, "output_tokens": 3200,
  "cost_usd": 0.052,
  "agent_usage": [
    { "agent_id": "main", "llm_calls": 2, "input_tokens": 9000, "output_tokens": 2200 },
    { "agent_id": "agent-77", "parent_agent_id": "main", "agent_type": "Explore", "llm_calls": 2, "input_tokens": 5500, "output_tokens": 1000 }
  ],
  "usage_status": "complete",
  "started_at": "2026-08-06T18:00:00Z", "ended_at": "2026-08-06T18:24:00Z"
}
```

- `developer_id` comes from `developerEmail` in the config (set during `agentwatch setup`,
  `--developer-email <email>` non-interactively), falling back to `git config user.email`.
- `prompt`/`response` text appears only when `capture.prompts`/`capture.responses` are enabled;
  otherwise only `{length, sha256}` evidence is included.
- A newly received summary has `usage_status: "pending"` (or `"provisional"` when Claude's
  transcript fallback supplied an early estimate). Only `"complete"` is billing-grade.
- `agent_usage` and all final token/cost fields are derived from deduplicated `llm.call` rows.

```json
{ "emit": { "turnSummaries": true, "llmCalls": true } }
```

`llmCalls` is mandatory and cannot be disabled globally or from `.agentwatch.json`.

```json
{ "otel": { "logs": true, "traces": false, "metrics": false } }
```

Which OTLP signals agents export natively (also settable non-interactively with
`agentwatch setup --otel <all|none|logs,traces,metrics>`). `logs` is the per-request usage/cost
ledger the backend turns into `llm.call` — on by default. `traces` (latency, TTFT, subagent
spans) and `metrics` (aggregate counters incl. active time) are opt-in. `--otel none` removes
the agents' native telemetry configuration entirely: turn summaries still flow through hooks,
but per-request cost/usage finalization is lost.

## Configuration layers

Configuration lives in two places, repo overriding global:

1. **Global** — `~/.agentwatch/config.json`, written by `agentwatch setup`. Endpoint, token,
   developer email, capture/emit defaults for the whole machine.
2. **Per repository** — `.agentwatch.json` in the repository root (found by walking up from the
   working directory, like `.git`). Overrides global settings for work in that repo: scalars
   replace, the `capture`/`emit`/`delivery` blocks merge field by field. Because this file is
   committed and shared, `token`, `installationId`, `developerEmail`, the `otel` signal
   selection and the delivery
   destinations (`endpoint`, `eventsUrl`, `otlpUrl`) are global-only and ignored here (with a
   warning in `--verbose`/`doctor` output) — a repo must not be able to redirect telemetry,
   steal the bearer token, or spoof developer attribution.

Repo overrides are applied only when the global config exists and is valid. If the global file
is missing or corrupt, hooks use the metadata-only fail-safe and ignore the repo file entirely.

```json
// .agentwatch.json — example: this repo opts out of response capture
{
  "capture": { "responses": false, "toolOutput": false }
}
```

`agentwatch config` prints the effective (merged) configuration and which files produced it.

## Backend endpoints

Any compatible backend works — nothing is hardcoded:

- Turn summaries: `POST <endpoint>/v1/events` with `{"events": [...]}` and optional
  `Authorization: Bearer <token>`.
- Native OTel: agents export OTLP/HTTP signals to `<endpoint>/v1/otlp` (standard signal paths
  are appended) — logs by default, traces/metrics when enabled via the `otel` config
  (`agentwatch setup --otel`). The receiver normalizes completed requests into `llm.call`,
  persists them before acknowledging OTLP, and discards the raw transport envelope afterward.
- Both URLs are independently overridable via `eventsUrl` / `otlpUrl` in
  `~/.agentwatch/config.json`.

The package exports the public types and backend helpers:

```ts
import type { ProductEvent } from '@agentwatch/bridge/events';
import { normalizeOtlpLogs } from '@agentwatch/bridge/otlp';
import { aggregateTurnUsage } from '@agentwatch/bridge/aggregate-turn';

const calls = normalizeOtlpLogs(otlpJson, { correlate });
await db.llmCalls.bulkUpsert(calls, ['provider', 'call_id']);
const finalized = aggregateTurnUsage(summary, await db.llmCalls.forTurn(summary.turn_id));
```

`correlate` is the backend lookup that joins session/turn/child-thread identifiers to the
root turn, summary Git/feature context and agent spawn edges. The example backend demonstrates OTLP
normalization; production code must add durable storage before returning the OTLP success body.

## Privacy model

**Full summary capture by default.** Out of the box, AgentWatch sends:

- `llm.call` identifiers, timestamps, model, usage, cost and agent/subagent correlation
- `turn.summary` prompt/final response, tool counts/names and touched-file paths
- repository name, hashed remote, branch, commit, repo-relative changed-file paths

Tool inputs/outputs are used only as local turn-assembly data and are not a third public event
stream. Recognized paths become repo-relative (basename outside the repo). Any capture category can be switched off per machine or per repo in
`~/.agentwatch/config.json`; with a category off, prompt/response bodies degrade to
`{length, sha256}` evidence only:

```json
{
  "capture": { "prompts": true, "responses": true, "toolInput": true, "toolOutput": true, "git": true, "files": true }
}
```

Everything that leaves the machine passes a recursive secret sanitizer (API keys, bearer tokens,
GitHub/AWS/Slack tokens, JWTs, private keys, URL-embedded credentials, password assignments).
Git remote URLs are stripped of credentials and also reported as a SHA-256 hash.

## Reliability

- Hooks run inside the agent's critical path with strict budgets: direct delivery uses a
  ~1.5 s timeout, and after a failed send a persisted 60 s circuit breaker makes subsequent
  hooks skip the direct attempt entirely (events go straight to the queue), so a dead
  backend costs at most one timeout per minute. On `Stop`, transcript token parsing adds a
  0.5–1.5 s settle window. Failures persist events to a bounded local queue
  (`~/.local/share/agentwatch/queue`), retried with exponential backoff on future hook
  invocations and by `agentwatch status`.
- While the events backend is down, turn summaries accumulate in the bounded local queue.
  Once it answers again, the next delivered summary (or `agentwatch status`) drains the backlog.
- OTLP reliability is the receiver's responsibility: acknowledge only after durable storage.
  Upsert `llm.call` by `(provider, call_id)` and `turn.summary` by `id`; exporter and bridge
  retries are then idempotent and token usage cannot be counted twice.

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
