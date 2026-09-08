# AgentWatch Edge

[![npm](https://img.shields.io/npm/v/@agent-watch-ai/edge)](https://www.npmjs.com/package/@agent-watch-ai/edge)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A lightweight, zero-daemon telemetry edge for AI coding agents (**Claude Code**, **OpenAI Codex**, **Cursor**, **Gemini CLI**, and **Google Antigravity**).

It connects agent lifecycle hooks and native OpenTelemetry (OTLP) to your observability backend to attribute LLM usage, costs, tool calls, Git branches, and ticket keys (e.g., `PAY-142`) — without model proxies, MITM intercepts, or background daemons.

---

## Quick Start

**Requirements:** Node.js 20+ (continuous integration runs the full suite on both Node 20 and Node 24, so the floor is verified rather than declared)

```bash
# 1. Install globally
npm install -g @agent-watch-ai/edge

# 2. Configure with your backend
agentwatch setup --endpoint https://backend.example.com --token YOUR_TOKEN

# 3. Verify status & diagnostics
agentwatch status
agentwatch doctor
```

---

## Supported Agents & Limitations

| Agent | Hook Configuration | Native OTel Signals | Status |
|---|---|---|---|
| **Claude Code** | `~/.claude/settings.json` | Logs, Traces, Metrics | Full support |
| **OpenAI Codex** | `~/.codex/hooks.json` | Logs, Traces (`~/.codex/config.toml`) | Full support |
| **Gemini CLI** | `~/.gemini/settings.json` | Logs, Traces, Metrics | Full support |
| **Cursor** | `~/.cursor/hooks.json` | None | Partial support |
| **Google Antigravity** | `~/.gemini/config/hooks.json` | None | Partial support |

### Agent Limitations & Notes

* **Claude Code**:
  * Running sessions must be restarted after `agentwatch setup` to apply telemetry environment variables.
* **OpenAI Codex**:
  * Requires trusting new hooks: launch `codex`, type `/hooks`, and approve AgentWatch entries.
* **Gemini CLI**:
  * Running sessions must be restarted after setup to load new hooks and OpenTelemetry configuration.
  * Telemetry is enabled through `GEMINI_TELEMETRY_ENABLED` with `GEMINI_TELEMETRY_TARGET=local`, and the ingest token travels in `OTEL_EXPORTER_OTLP_HEADERS`. Gemini CLI does not support Claude Code's `otelHeadersHelper`.
* **Google Antigravity**:
  * **No native token usage**: Antigravity exposes no OpenTelemetry exporter configuration and no readable transcript usage, so `turn.summary` events remain `usage_status: "pending"` and carry no cost.
  * **Turns, not model calls**: a turn is one *execution*. `PreInvocation`/`PostInvocation` bracket the individual model calls inside an execution, and only the `Stop` hook closes a turn.
  * The prompt is read from `common.lastUserInput` — Antigravity has no user-prompt hook of its own.
  * Running sessions must be restarted after `agentwatch setup` to load new hooks.
* **Cursor**:
  * **No native token usage**: Cursor exposes no token usage in hooks or transcripts, so `turn.summary` events remain `usage_status: "pending"`.
  * **Cursor CLI**: Currently emits only shell hook events. Full hook lifecycle is available only in Cursor IDE sessions.
  * **Cloud VMs**: Cloud agents do not have access to the local user hook or binary by default; they require an explicit committed `.cursor/hooks.json` and package installation in the cloud environment.
  * **Tab suggestions**: AgentWatch monitors accepted edits (`afterTabFileEdit`) and intentionally ignores high-frequency `beforeTabFileRead` events.

---

## CLI Commands

```bash
# Setup & Configuration
agentwatch setup --endpoint https://backend.example.com    # Interactive / automated setup
agentwatch config                                         # Print active configuration (secrets redacted)
agentwatch agents                                         # List detected agents & status

# Diagnostics & Status
agentwatch status                                         # Backend, queue, and agent health
agentwatch doctor                                         # Run environment checks (use --json for CI)

# Hook Execution (invoked automatically by agents)
agentwatch hook --agent claude                            # Process stdin payload from agent
agentwatch hook --agent codex --dry-run                   # Test hook output without sending

# Telemetry & Teardown
agentwatch off                                           # Stop hooks; remove managed native exporters
agentwatch on                                            # Restore operation (restart running agents)
agentwatch otel-headers                                   # Output formatted OTel headers
agentwatch uninstall                                      # Remove hooks and restore backups
agentwatch uninstall --purge                              # Also delete ~/.agentwatch and queues
```

---

## Parameters & Flags

| Flag | Description | Default |
|---|---|---|
| `--endpoint <url>` | Backend base URL for event ingestion | — |
| `--token <token>` | Bearer token for backend authentication | — |
| `--developer-email <email>` | Identity attached to turn summaries and keyed on by per-developer enforcement. Setup refuses to write a config when neither this flag nor git names a developer | `git config user.email` |
| `--root <path>` | File a second identity under a project root (needs its own `--token`; the machine identity must already be set up), so one machine can report to two tenants | — |
| `--otel <signals>` | OTLP signals exported by agents: `logs`, `traces`, `metrics`, `all`, or `none` | `logs` |
| `--agent <id>` | Limit command to a single agent (`claude`, `codex`, `cursor`, `gemini`, `antigravity`) | All detected |
| `--yes`, `--non-interactive` | Non-interactive mode (fail instead of prompting on missing args) | `false` |
| `--purge` | Used with `uninstall`: removes `~/.agentwatch` and local queues | `false` |
| `--dry-run` | Used with `hook`: prints canonical events to stdout instead of sending | `false` |
| `--json` | Used with `doctor`: output machine-readable JSON | `false` |
| `--verbose` | Print verbose diagnostic logs to stderr | `false` |
| `--version` | Display edge version | — |

---

## Configuration

* **Global configuration**: `~/.agentwatch/config.json` (managed via `agentwatch setup`).

### Content capture

Content capture is **off by default**. Prompts, agent responses, tool inputs and tool outputs stay
on the machine unless you turn them on in `~/.agentwatch/config.json` — which takes two things: the
global `contentCaptureConsent` marker *and* the individual flag. The marker on its own enables
nothing, and a flag on its own collects nothing.

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

`git` and `files` are on by default because they carry metadata, not content: the repo remote,
branch and SHA, and the *path* of a file the agent touched. That is what feature and project
attribution is built from. A prompt is still recorded as a length and a SHA-256 either way — never
the text — so turn counts and cost attribution work with capture fully off.

*Upgrading?* An existing config is **not** trusted to keep capturing. A machine installed on an
earlier release has all six flags written into `~/.agentwatch/config.json`, but without
`contentCaptureConsent` those four content flags read as `false` — an upgrade that replaces the CLI
cannot silently carry an old decision forward. Your flags are kept as written, by loading and by
`agentwatch setup` alike, so adding the marker later turns them back on rather than starting over;
setup says which ones are set but inert. `agentwatch doctor` reports the effective posture for the
directory you are in.

*Native exporters are separate.* Codex and Gemini usage logs can carry tool arguments and results
with no per-field filter, so setup configures them only when consent covers both `toolInput` and
`toolOutput` — which can leave `llm.call` usage unavailable for those two in metadata-only mode.
Claude's own content-logging switches are forced off either way. None of this takes effect in an
agent that is already running: rerun `agentwatch setup` after upgrading, then restart your agents.

### Fleet deployment

[`examples/mdm/`](https://github.com/agent-watch-ai/agent-watch-edge/tree/main/examples/mdm) has a Jamf/Kandji script, an Intune
script, and a Claude Code `managed-settings.json` policy file — plus a straight
per-agent answer about what an administrator can and cannot lock, which for
every agent but Claude Code is currently "the developer can remove the hooks".

### Stopping collection without uninstalling

`agentwatch off` stops hooks, withholds the OTLP bearer token, and removes the native exporters
AgentWatch installed — keeping your config, queued events and everything else in place.
`agentwatch on` puts them back. Restart running agents either way: an already-started agent holds
its exporters and headers in memory. See [docs/DATA_HANDLING.md](docs/DATA_HANDLING.md) for what
the off switch does and does not reach.

* **Repository overrides**: Place a `.agentwatch.json` in any repository root to turn capture
  **down** for that repository:

```json
{
  "capture": { "prompts": false, "toolOutput": false }
}
```

*Note: a repository file may only ever narrow capture. A committed `.agentwatch.json` that sets a
capture flag the machine has off is ignored, with a warning — `agentwatch doctor` and
`agentwatch config` both show it — so checking a repository out can never start collecting content
on someone else's machine. Infrastructure settings (`endpoint`, `token`, `developerEmail`,
`enforcementUrl`), the `roots` block, and the `delivery`, `otel` and `enforcement` blocks are global-only too: a
committed repo file cannot redirect delivery or switch off a budget cap for everyone who clones the
repository.*

* **Per-project identity (two tenants, one machine)**: `roots` in the global config maps an absolute project root to the identity used beneath it. Work outside every root keeps the machine's own. Set the machine identity up first, then add a root with `agentwatch setup --root ~/dev/tripPlanner --token <token>` — the root needs its own token, the machine's is never inherited — or by hand:

```json
{
  "endpoint": "https://backend.example.com",
  "token": "<the machine default>",
  "roots": {
    "/Users/me/dev/tripPlanner": { "token": "<tenant A>" },
    "/Users/me/dev/acme": { "token": "<tenant B>", "developerEmail": "me@acme.com" }
  }
}
```

Longest match wins, so a checkout nested inside a workspace overrides the workspace. Point a root at the directory your agent actually opens: a session started one level above a root does not match it. Only identity varies per root — what is captured and which OTLP signals are exported stay machine-wide, so `--otel` is refused together with `--root`, and `roots` is global-only like the fields it carries.

*Caveat: agents export native OTLP to one machine-wide endpoint, so roots on different backends split the hook path but not that export: under such a root `otel-headers` sends no bearer rather than one tenant's token to the other's collector, and that tenant's `llm.call` ledger gets hook-path events only. Roots on the same backend — the usual case — differ only in bearer, which `otel-headers` resolves per directory.*

The offline queue is partitioned to match: `<data>/queue/<digest-of-token>/`, one directory per identity, so a drain only ever sends the backlog belonging to the token it is signing with; the backend cooldown and loss tally are per identity too. An idle tenant's backlog waits for that tenant's next hook rather than leaving under someone else's bearer. Upgrading from a version without partitions adopts the existing backlog automatically when the machine has a single identity; when it already has several, those entries name no tenant, so they are moved to `<data>/queue/unattributed/` and delivered to nobody — `agentwatch status` and `agentwatch doctor` say how many and where. Move them into a tenant's partition to deliver them, or delete the directory to discard them.

### Budget enforcement (pre-turn check)

When a backend budget policy is set to **block** and the developer has breached it, the Edge stops
the turn before the agent's first LLM call: the prompt is refused in the agent's own protocol
(Claude Code, Codex, Cursor, Gemini CLI) with the backend's explanation shown to the developer.

```json
{
  "enforcement": { "enabled": true, "timeoutMs": 300, "cacheTtlMs": 60000 }
}
```

The check **fails open, always**. A turn stops only on an explicit `{"decision":"block","message":"…"}`
from `GET <backend>/v1/enforcement/decision`; an unreachable backend, a timeout, any other status and
any body the Edge cannot read all let the turn proceed silently. Set `enabled: false` to opt out.

Decisions are cached locally for `cacheTtlMs`, so a flat cap costs at most one bounded request per
turn. A *feature-scoped* cap costs one per gated prompt: the platform answers `cache_ttl_ms: 0`
because a reuse key cannot tell one checkout from another, and the Edge honours that by not storing
the answer. Either way the request is on the hook path, which means an outage un-enforces budgets
rather than stopping anyone — see [docs/DATA_HANDLING.md](docs/DATA_HANDLING.md).

Antigravity is not gated: its pre-invocation hook carries no decision field, so there is no
prompt-level refusal to send. Its usage is still reported and still raises alerts.

To try it locally: `BLOCK=1 npm run example` answers every check with a refusal.

---

## Data Flow & Backend Integration

1. **`turn.summary`**: Generated via agent hooks (`POST <backend>/v1/events`). Includes prompt/response length and hash metadata, tool counts, file paths, Git branch, and ticket keys. Raw prompt and response text require explicit global consent and enabled capture flags.
2. **`llm.call`**: Emitted via native OTLP (`POST <backend>/v1/otlp/v1/logs`). Contains token usage, cost, and latency per model request.
3. The backend joins `llm.call` to `turn.summary` records using conversation/turn IDs.
4. **`repo.snapshot`**: Reports changed branch/commit metadata, including commit subjects, when Git capture is enabled.

Read the [data handling contract](docs/DATA_HANDLING.md) for the exact fields,
privacy migration, local retention, native-exporter limitations, and off-switch
behavior. See [enterprise deployment](docs/ENTERPRISE_DEPLOYMENT.md) for release
artifacts and explicitly deferred enterprise features.

### Backend SDK Helpers

```ts
import type { ProductEvent } from '@agent-watch-ai/edge/events';
import { normalizeOtlpLogs } from '@agent-watch-ai/edge/otlp';
import { aggregateTurnUsage } from '@agent-watch-ai/edge/aggregate-turn';
```

---

## License

MIT © [Aleksandr Repetskyi](https://github.com/alexrepetskyi)
