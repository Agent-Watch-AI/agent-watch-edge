# AgentWatch Edge

[![npm](https://img.shields.io/npm/v/@agentwatch-ai/edge)](https://www.npmjs.com/package/@agentwatch-ai/edge)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A lightweight, zero-daemon telemetry edge for AI coding agents (**Claude Code**, **OpenAI Codex**, **Cursor**, **Gemini CLI**, and **Google Antigravity**).

It connects agent lifecycle hooks and native OpenTelemetry (OTLP) to your observability backend to attribute LLM usage, costs, tool calls, Git branches, and ticket keys (e.g., `PAY-142`) — without model proxies, MITM intercepts, or background daemons.

---

## Quick Start

**Requirements:** Node.js 20+

```bash
# 1. Install globally
npm install -g @agentwatch-ai/edge

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
* **Repository overrides**: Place a `.agentwatch.json` in any repository root to adjust content capture:

```json
{
  "capture": {
    "prompts": true,
    "responses": false,
    "toolInput": true,
    "toolOutput": false,
    "git": true,
    "files": true
  }
}
```

*Note: Infrastructure settings (`endpoint`, `token`, `developerEmail`, `enforcementUrl`) and the
`delivery`, `otel` and `enforcement` blocks are global-only — a committed repo file cannot redirect
delivery or switch off a budget cap for everyone who clones the repository.*

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
any body the Edge cannot read all let the turn proceed silently. Decisions are cached locally for
`cacheTtlMs`, so the check costs one bounded request per turn at most. Set `enabled: false` to opt out.

Antigravity is not gated: its pre-invocation hook carries no decision field, so there is no
prompt-level refusal to send. Its usage is still reported and still raises alerts.

To try it locally: `BLOCK=1 npm run example` answers every check with a refusal.

---

## Data Flow & Backend Integration

1. **`turn.summary`**: Generated via agent hooks (`POST <backend>/v1/events`). Captures user prompt, tools executed, files touched, Git branch, and ticket keys.
2. **`llm.call`**: Emitted via native OTLP (`POST <backend>/v1/otlp/v1/logs`). Contains token usage, cost, and latency per model request.
3. The backend joins `llm.call` to `turn.summary` records using conversation/turn IDs.

### Backend SDK Helpers

```ts
import type { ProductEvent } from '@agentwatch-ai/edge/events';
import { normalizeOtlpLogs } from '@agentwatch-ai/edge/otlp';
import { aggregateTurnUsage } from '@agentwatch-ai/edge/aggregate-turn';
```

---

## License

MIT © [Aleksandr Repetskyi](https://github.com/alexrepetskyi)
