# AgentWatch Bridge — Architecture

Status: implementation blueprint (written before code, per project process).
Date: 2026-08-07.

Every provider-specific claim below is tagged:

- **[docs]** — verified from current official documentation/source (August 2026).
- **[ref]** — verified from the reference repository `o11y-dev/opentelemetry-hooks` (v0.14.0).
- **[assumption]** — assumption requiring validation.

---

## 1. Reference repository analysis

`o11y-dev/opentelemetry-hooks` (MIT-declared, Python, ~6k-line single module + bash installer) bridges
native coding-agent hooks (Cursor, Windsurf, Claude Code, Copilot, Gemini, Codex, OpenCode) to
OpenTelemetry traces/logs. Key ideas worth reusing **[ref]**:

- **One short-lived process per hook callback.** Event JSON on stdin → normalize → emit → exit.
  Cross-invocation state lives on disk (`~/.local/share/<tool>/.state/{sessions,batches,locks}`).
- **Idempotent config merging.** Hook registration is keyed on the hook command substring
  (`otel-hook`): existing entries are updated in place, others appended; JSON is merged, never
  clobbered. Uninstall filters out only entries whose command contains the tool's own name.
- **Deterministic event IDs.** Provider-supplied IDs preferred; otherwise
  `"hook:" + sha256(canonical-JSON of stable fields)`, with an `event_id_source` marker.
- **Dedup + correlation state.** Bounded per-session dedup ledger; PreToolUse/PostToolUse matched
  through a persisted `tool_invocations` record; subagent start/stop matched via agent IDs.
- **Privacy: content off by default.** Raw prompt/response text is stripped at the adapter and
  replaced by `length` + `sha256`. Git remotes emitted only as a SHA-256 of the normalized,
  credential-free URL. Doctor sanitizes endpoints; delivery errors stored as hash+length.
- **Diagnostics with a stable JSON schema.** `doctor --json` reports registrations, exporter
  health, state-dir writability; exit 1 on degraded.
- **Never invent correlation.** Native trace/span IDs from payloads become OTel span *links*, not
  parents; agent IDs minted by the hook are marked `agent_id_source: "hook"`.
- Weaknesses we deliberately avoid: single 6,000-line module; background venv self-bootstrap;
  Codex uninstall leaves `[features] hooks = true` behind; no LICENSE file despite MIT metadata.

No source code is ported; ideas only. Attribution given in README.

## 2. TypeScript architecture

Two telemetry sources, deliberately kept distinct:

- **Source A — hooks**: agent invokes `agentwatch hook --agent <id>` with JSON on stdin. The
  process parses via a provider adapter into canonical `AgentWatchEvent`s, enriches with Git
  context, sanitizes, attempts one fast HTTP delivery (short timeout), falls back to a bounded
  on-disk queue, writes the provider-safe response to stdout, exits. No daemon.
- **Source B — native OTel**: `agentwatch setup` writes each agent's *official* telemetry
  configuration so the agent itself exports OTLP (tokens/cost/model) straight to the backend. The
  Bridge never re-derives token usage.

Correlation happens downstream: both streams carry the provider session ID
(Claude: hook `session_id` == OTel `session.id` **[docs]**; Codex: hook `thread_id`/`session_id` ==
OTel `conversation.id` **[docs]**).

Core is dependency-light: `zod` (runtime validation), `smol-toml` (read/inspect Codex TOML).
CLI arg parsing, colors and logging are hand-rolled to keep hook startup fast. All filesystem
paths and environment access flow through an injectable `Env` object so tests never touch the real
`$HOME`.

## 3. Directory structure

```
src/
  cli.ts                     # bin entry; fast-path dispatch for `hook`
  cli/                       # setup, status, doctor, uninstall, hook, agents, config, otel-headers
  core/                      # env.ts (injectable HOME/env/exec), logger.ts (stderr-only), version.ts
  events/                    # canonical-event.ts (types+zod), event-id.ts, canonical-types.ts
  providers/                 # provider.ts (interfaces), registry.ts
    claude/                  # detect, hooks install/uninstall, adapter, otel configurator
    codex/                   # detect, hooks install/uninstall, adapter, otel configurator
  git/                       # git-context.ts (execFile git, timeouts), remote-sanitize.ts
  feature/                   # ticket-candidates.ts (branch → ticket evidence)
  privacy/                   # sanitizer.ts, secret-patterns.ts
  transport/                 # transport.ts (interface), http-transport.ts, queue.ts, delivery.ts
  config/                    # config.ts (schema), config-store.ts
  enrollment/                # enrollment-provider.ts, manual-enrollment.ts
  storage/                   # paths.ts (XDG), atomic-file.ts, lock.ts, json-file.ts, install-state.ts
  diagnostics/               # doctor-checks.ts
tests/                       # vitest; fixtures/ with realistic provider payloads
```

## 4. Canonical event schema (v1)

As specified in the product brief, with these refinements:

- `session.providerId` preserved verbatim alongside a normalized `session.id` (same value for
  Claude/Codex; never invented).
- `ai.usage.source: "native_otel" | "hook_payload" | "unknown"` and
  `ai.billingMode: "api" | "subscription" | "unknown"`.
- `event.providerEventType` keeps the native name (`PostToolUse`, …).
- `metadata.provider.*` namespaces raw provider identifiers we cannot normalize
  (`tool_use_id`, `prompt_id`, `permission_mode`, `turn_id`, …).
- Canonical types: `session.started/.ended`, `prompt.submitted`, `tool.started/.completed/.failed`,
  `permission.requested`, `file.read`, `file.edited`, `shell.started/.completed`,
  `mcp.started/.completed`, `subagent.started/.completed`, `generation.completed`, `agent.error`,
  `compaction.started/.completed`.
- Event IDs: `evt_` + SHA-256 over `{provider, providerEventType, sessionId, turnId, toolUseId,
  promptId, timestampBucket, payloadFingerprint}`; provider event IDs win when present. No raw
  content in the hash input — content is fingerprinted (sha256) first.

## 5. Claude Code integration **[docs]** (code.claude.com/docs, fetched 2026-08-07)

- **Hooks config**: `~/.claude/settings.json` (user scope; project scopes exist but we default to
  user), schema `hooks → EventName → [{ matcher?, hooks: [{type:"command", command, timeout}] }]`.
  Registered events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `PostToolUseFailure`, `PermissionRequest`, `Stop`, `SubagentStart`, `SubagentStop`.
  Command: `agentwatch hook --agent claude` (absolute bin path resolved at setup when possible),
  `timeout: 30` (seconds). Matcher `"*"` only on tool events.
  Caution: user/project settings files are validated **strictly** (invalid file rejected as a
  whole), so we write only documented keys and validate JSON after mutation.
- **Payload**: all events carry `session_id`, `prompt_id`, `transcript_path`, `cwd`,
  `permission_mode`, `hook_event_name` (+ `agent_id`/`agent_type` in subagents). Tool events add
  `tool_name`, `tool_input`, `tool_use_id`; PostToolUse adds `tool_response`/`tool_error`;
  UserPromptSubmit adds `prompt`; Stop adds `last_assistant_message`, `stop_hook_active`;
  SessionStart adds `source` (+ sometimes `model`); SessionEnd adds `reason`.
- **Response contract**: exit 0 + empty stdout is the safe passive no-op for every event (stdout
  on UserPromptSubmit/SessionStart is *injected into model context*, so we emit nothing).
  Diagnostics go to stderr only. Non-zero non-2 exit codes are non-blocking.
- **Native OTel**: enabled via env vars in the settings.json `env` block:
  `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`,
  `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` (no default — must be explicit),
  `OTEL_EXPORTER_OTLP_ENDPOINT=<otlp base>`. Bearer auth via the documented `otelHeadersHelper`
  settings key pointing at `agentwatch otel-headers` — the token stays in `~/.agentwatch`, never
  in Claude's settings. Usage arrives as `claude_code.token.usage` metrics and
  `claude_code.api_request` log events (input/output/cacheRead/cacheCreation tokens, cost, model),
  all carrying `session.id`.

## 6. Codex integration **[docs]** (openai/codex @ main, developers.openai.com, 2026-08-07)

- Codex now ships a Claude-style lifecycle hooks system (events: `SessionStart`, `SessionEnd`,
  `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`,
  `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`). Command hooks receive JSON on stdin
  (`session_id`, `turn_id`, `cwd`, `hook_event_name`, `model`, tool fields) and may answer with
  `{continue, stopReason, suppressOutput, systemMessage}` (strict `deny_unknown_fields`).
  We install into `~/.codex/hooks.json`, whose top level is strictly `{description?, hooks}`
  (serde `deny_unknown_fields` — any other key makes Codex skip the file) **[docs]**. Matchers
  are optional (absent = match everything) **[docs]**. Trust flow **[docs]**: non-managed hooks
  do NOT run until the user trusts them via `/hooks` in the Codex TUI (trust hash stored under
  `hooks.state` in config.toml) — setup prints this required step. Hooks feature is enabled by
  default (`Feature::CodexHooks`, stable, default true) **[docs]**.
  `notify` (argv-JSON, `agent-turn-complete` only) is treated as legacy and not used.
- Passive response: empty stdout + exit 0 is explicitly treated as success by Codex's
  output parser **[docs]**.
- **Native OTel**: `[otel]` table in `~/.codex/config.toml` —
  `exporter = { otlp-http = { endpoint, protocol = "binary", headers } }`. Defaults: log/trace
  export off. Exported log events include `codex.sse_event` (`response.completed` carries
  input/output/cached/reasoning token counts) and every event carries `conversation.id`,
  `auth_mode` (`ApiKey`/`Chatgpt` → our `billingMode`), `model` — the correlation keys.
  Project-level `.codex/config.toml` ignores `otel`/`notify` keys, so we only write the user-level
  file. TOML editing strategy: never rewrite the user's file through parse→stringify (comments
  would be lost). We append a fenced, marker-delimited block
  (`# >>> agentwatch >>> … # <<< agentwatch <<<`) only when no `[otel]` table exists; if the user
  already has `[otel]`, we skip and report instead of fighting over it. We never write
  `[features]` (duplicate-table risk could corrupt the whole file); doctor warns if
  `features.hooks = false`.

## 7. Native OTel configuration strategy

`NativeTelemetryConfigurator` per provider (`supported/inspect/configure/uninstall`). Setup asks
once for the backend base URL; derived endpoints (all overridable in `~/.agentwatch/config.json`):
`<base>/v1/events` for hook events, `<base>/v1/otlp` as the OTLP base (standard OTLP/HTTP path
appending yields `/v1/otlp/v1/metrics` etc. — kept configurable because collectors differ).
The Bridge does not convert or proxy OTLP; agents export directly. Ownership tracking: everything
we write is recorded in `~/.agentwatch/install-state.json` so uninstall removes exactly what we
added (with match-by-marker fallbacks).

## 8. Correlation strategy

| stream | Claude Code | Codex |
|---|---|---|
| hook | `session_id`, `prompt_id`, `tool_use_id`, `agent_id` | `session_id`/`thread_id`, `turn_id`, `call_id` |
| native OTel | `session.id`, `prompt.id`, `tool_use_id` | `conversation.id`, `turn` attrs |

Canonical events carry these verbatim (`session.providerId`, `session.turnId`,
`metadata.provider.*`). The Bridge never fabricates missing IDs; absent fields stay absent. The
backend joins hook lifecycle + OTLP usage + Git/feature evidence.

## 9. Setup flow

1. Resolve Git context (never fails hard outside a repo).
2. Detect agents: config dirs (`~/.claude`, `~/.codex`, project `.claude`/`.codex`) + executables
   on PATH (`claude`, `codex`) + existing hook registrations.
3. Prompt for backend URL (skipped when `--endpoint` given or config exists); optional token.
   Endpoint handling sits behind `EnrollmentProvider`; MVP ships `ManualEnrollmentProvider`, and a
   future `RemoteEnrollmentProvider` (`agentwatch setup <enrollment-url>`) slots in without
   changing setup.
4. Per detected agent: install hooks (merge, idempotent, backup + atomic write + post-write
   validation) and configure native OTel.
5. Print summary + any manual steps (e.g. Codex hook approval, restarting agents).

## 10. Risks & unknowns

1. Codex hook trust: events flow only after the user trusts the hook via `/hooks` (verified);
   setup cannot automate this safely (trust hash is a fragile positional digest), so onboarding
   depends on the user completing one manual step.
2. Codex `[features] hooks` default is enabled (verified); we still never write `[features]`
   (duplicate-table corruption risk) and only warn when it is disabled.
3. Claude settings strict validation: a schema drift in what we write could invalidate the whole
   file → we validate post-write and keep a timestamped backup; restore on failure.
4. Hook process startup cost (Node ≈ 50–100 ms per event ×10 events/turn) — acceptable, but we
   keep imports lazy on the hook path and cap network wait at ~1.5 s.
5. Claude OTel export goes to *one* endpoint per env-var set; if the user already exports
   telemetry elsewhere we must not clobber it → configurator skips + reports when foreign
   `OTEL_*` values exist.
6. `claude_code.*` metric names and Codex `[otel]` shape are current today but explicitly
   versioned nowhere — pinned in per-provider modules, covered by doctor, documented in README.
7. Windows support: paths module isolates XDG/APPDATA decisions; hooks themselves are
   shell-command based and untested on Windows in this MVP (documented limitation).
