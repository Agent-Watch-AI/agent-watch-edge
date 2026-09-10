# AgentWatch Edge

[![npm](https://img.shields.io/npm/v/@agent-watch-ai/edge)](https://www.npmjs.com/package/@agent-watch-ai/edge)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**See what your AI coding agents cost — per developer, repository and ticket.**

It reads the agents' own hooks and their native OpenTelemetry export, and sends usage, cost and Git
context to your backend. Nothing sits in front of the model: no proxy, no MITM certificate, no
daemon, no root.

Supports **Claude Code**, **OpenAI Codex**, **Cursor**, **Gemini CLI** and **Google Antigravity**.

---

## Quick Start

**Requirements:** Node.js 20+ — CI runs the whole suite on Node 20 and Node 24 on Linux and macOS. Windows deployment remains unverified.

```bash
npm install -g @agent-watch-ai/edge
agentwatch setup --endpoint https://backend.example.com --token YOUR_TOKEN
agentwatch doctor    # is this machine actually reporting?
```

Restart any running agent afterwards: hooks and exporters are read at startup.

---

## Supported Agents

| Agent | Hooks configured in | Native OTel signals | Token usage |
|---|---|---|---|
| **Claude Code** | `~/.claude/settings.json` | Logs, Traces, Metrics | Yes |
| **OpenAI Codex** | `~/.codex/hooks.json` | Logs, Traces (`~/.codex/config.toml`) | Yes |
| **Gemini CLI** | `~/.gemini/settings.json` | Logs, Traces, Metrics | Yes |
| **Cursor** | `~/.cursor/hooks.json` | None | **No** |
| **Google Antigravity** | `~/.gemini/config/hooks.json` | None | **No** |

Cursor and Antigravity expose no token usage in hooks or transcripts, so their `turn.summary`
events stay `usage_status: "pending"` and carry no cost. Everything else — turns, tools, files,
branches, ticket keys — is reported for all five.

Per-agent notes:

* **OpenAI Codex** — new hooks must be trusted once: launch `codex`, type `/hooks`, approve the AgentWatch entries.
* **Gemini CLI** — telemetry runs through `GEMINI_TELEMETRY_ENABLED` with `GEMINI_TELEMETRY_TARGET=local`, and the ingest token travels in `OTEL_EXPORTER_OTLP_HEADERS`; Gemini has no `otelHeadersHelper`.
* **Google Antigravity** — a turn is one *execution*: `PreInvocation`/`PostInvocation` bracket the model calls inside it and only `Stop` closes it. The prompt comes from `common.lastUserInput`; there is no user-prompt hook.
* **Cursor** — the CLI emits shell hooks only; the full lifecycle exists in IDE sessions. Cloud agents need a committed `.cursor/hooks.json` and the package installed in the cloud environment. Accepted tab edits (`afterTabFileEdit`) are monitored; high-frequency `beforeTabFileRead` is ignored.

---

## CLI

```bash
agentwatch setup --endpoint https://backend.example.com   # install hooks and exporters
agentwatch status                                         # backend, queue and agent health
agentwatch doctor                                         # environment checks (--json for CI)
agentwatch config                                         # active configuration, secrets redacted
agentwatch agents                                         # detected agents and their state

agentwatch off                                            # stop hooks, remove managed exporters
agentwatch on                                             # put them back
agentwatch uninstall [--purge]                            # remove hooks; --purge also deletes ~/.agentwatch

agentwatch hook --agent claude [--dry-run]                # invoked by the agents themselves
agentwatch otel-headers                                   # print OTel headers for an agent
```

| Flag | Meaning | Default |
|---|---|---|
| `--endpoint <url>` | Backend base URL. `https:`, or `http:` to loopback | — |
| `--token <token>` | Bearer token for the backend | — |
| `--developer-email <email>` | Identity on turn summaries, and what per-developer budgets key on. Setup refuses to write a config when neither this flag nor git names a developer | `git config user.email` |
| `--root <path>` | File a second identity under a project root, so one machine can report to two tenants (needs its own `--token`) | — |
| `--otel <signals>` | Signals the agents export: `logs`, `traces`, `metrics`, `all`, `none` | `logs` |
| `--agent <id>` | Limit the command to one agent (`claude`, `codex`, `cursor`, `gemini`, `antigravity`) | all detected |
| `--yes`, `--non-interactive` | Fail instead of prompting | `false` |
| `--dry-run` | With `hook`: print the events instead of sending them | `false` |
| `--json` | With `doctor`: machine-readable output | `false` |
| `--verbose` | Diagnostic logs on stderr | `false` |
| `--version` | Print the version | — |

---

## Configuration

One global file: `~/.agentwatch/config.json`, written by `agentwatch setup`.

### Content capture is off by default

Prompts, responses, tool inputs and tool outputs stay on the machine. Turning one on takes **two**
things — the global `contentCaptureConsent` marker *and* the individual flag. The marker alone
enables nothing; a flag alone collects nothing.

```json
{
  "contentCaptureConsent": true,
  "capture": {
    "prompts": false,
    "responses": false,
    "toolInput": false,
    "toolOutput": false,
    "git": true,
    "files": true
  }
}
```

`git` and `files` are on because they carry metadata, not content: remote, branch, SHA, and the
*path* of a file the agent touched — which is what feature and project attribution is built from.
A prompt is always recorded as a length and a SHA-256, never as text, so turn counts and cost
attribution work with capture fully off.

**Upgrading from an earlier release?** Its config has all six flags written into it, but without the
consent marker the four content flags read as `false` — replacing the CLI cannot carry an old
decision forward silently. Your flags are kept as written, so adding the marker later turns them
back on rather than starting over; `setup` names the ones that are set but inert. `agentwatch doctor`
reports the effective posture for the directory you are in.

**Native exporters are gated separately.** Codex and Gemini usage logs can carry tool arguments and
results with no per-field filter, so setup configures them only when consent covers both
`toolInput` and `toolOutput` — which can leave `llm.call` usage unavailable for those two in
metadata-only mode. Claude's own content-logging switches are forced off either way.

### Repository overrides

A `.agentwatch.json` in a repository root can only turn capture **down** for that repository:

```json
{ "capture": { "prompts": false, "toolOutput": false } }
```

A committed file that asks for *more* than the machine allows is ignored with a warning, so
checking a repository out can never start collecting content on someone else's machine. `endpoint`,
`token`, `developerEmail`, `enforcementUrl`, `roots` and the `delivery` / `otel` / `enforcement`
blocks are global-only: a repository file cannot redirect delivery or switch off a budget cap.

### Two tenants on one machine

`roots` maps an absolute project root to the identity used beneath it; work outside every root keeps
the machine's own. Set the machine up first, then
`agentwatch setup --root ~/dev/acme --token <tenant token>` — a root never inherits the machine's
token — or by hand:

```json
{
  "endpoint": "https://backend.example.com",
  "token": "<machine default>",
  "roots": {
    "/Users/me/dev/tripPlanner": { "token": "<tenant A>" },
    "/Users/me/dev/acme": { "token": "<tenant B>", "developerEmail": "me@acme.com" }
  }
}
```

Longest match wins. Point a root at the directory the agent actually opens: a session started one
level above it does not match. Only identity varies per root — capture and OTel signals stay
machine-wide, so `--otel` is refused together with `--root`.

The offline queue is partitioned to match (`<data>/queue/<digest-of-token>/`), as are the backend
cooldown and the loss tally, so a drain only ever sends the backlog belonging to the token it signs
with. Agents export native OTLP to one machine-wide endpoint, so under a root pointing at a
*different* backend `otel-headers` sends no bearer rather than the wrong tenant's — that tenant then
gets hook-path events only. Roots on the same backend, the usual case, differ only in bearer.

Upgrading from a version without partitions adopts an existing backlog when the machine has one
identity; when it already has several, those entries name no tenant and are moved to
`<data>/queue/unattributed/`, where `status` and `doctor` report them. Move them into a partition to
deliver them, or delete the directory to discard them.

### Stopping collection without uninstalling

`agentwatch off` stops the hooks before they read stdin, withholds the OTLP bearer, and removes the
exporters AgentWatch installed — keeping config and queued events. `agentwatch on` restores it.
Restart running agents either way. See [docs/DATA_HANDLING.md](docs/DATA_HANDLING.md) for what the
off switch does and does not reach.

### Fleet deployment

[`examples/mdm/`](https://github.com/agent-watch-ai/agent-watch-edge/tree/main/examples/mdm) has a
Jamf/Kandji script, an Intune script, a Claude Code `managed-settings.json` policy file, and a
per-agent answer about what an administrator can lock — which for every agent but Claude Code is
currently "the developer can remove the hooks".

### Budget enforcement

When a backend budget is set to **block** and the developer has breached it, the turn is refused
before the agent's first LLM call, in the agent's own protocol (Claude Code, Codex, Cursor, Gemini
CLI), with the backend's explanation shown to the developer.

```json
{ "enforcement": { "enabled": true, "timeoutMs": 300, "cacheTtlMs": 60000 } }
```

The check **fails open, always.** A turn stops only on an explicit
`{"decision":"block","message":"…"}` from `GET <backend>/v1/enforcement/decision`; an unreachable
backend, a timeout, any other status and any unreadable body let the turn proceed silently — so an
outage un-enforces budgets rather than stopping anyone. Set `enabled: false` to opt out.

Decisions are cached for `cacheTtlMs`, so a flat cap costs at most one bounded request per turn. A
feature-scoped cap costs one per gated prompt: the backend answers `cache_ttl_ms: 0` and the edge
honours that by not storing the answer. Antigravity is not gated — its pre-invocation hook carries
no decision field — but its usage is still reported and still raises alerts.

To try it locally: `BLOCK=1 npm run example` refuses every check.

---

## What reaches the backend

| Record | How | Contents |
|---|---|---|
| `turn.summary` | Edge hooks → `POST <backend>/v1/events` | One completed turn: prompt/response length and hash, tool counts, file paths, Git branch, ticket keys. Raw text only with consent *and* the flag. |
| `llm.call` | The agent's own OTLP → `POST <backend>/v1/otlp/v1/logs` | Token usage, cost and latency per model request. The edge does not proxy this. |
| `repo.snapshot` | Edge hooks, after a closed turn | Changed branch/commit metadata, including commit subjects, when Git capture is on. |

The backend joins `llm.call` to `turn.summary` on conversation and turn ids.

Exact fields, local retention, privacy migration and off-switch behaviour:
[docs/DATA_HANDLING.md](docs/DATA_HANDLING.md). Release artifacts, rollback verification and the
explicitly deferred enterprise work (Windows, native binaries, signing, SOC 2):
[docs/ENTERPRISE_DEPLOYMENT.md](docs/ENTERPRISE_DEPLOYMENT.md).

### Backend SDK helpers

```ts
import type { ProductEvent } from '@agent-watch-ai/edge/events';
import { normalizeOtlpLogs } from '@agent-watch-ai/edge/otlp';
import { aggregateTurnUsage } from '@agent-watch-ai/edge/aggregate-turn';
```

---

## License

MIT © [Aleksandr Repetskyi](https://github.com/alexrepetskyi)
