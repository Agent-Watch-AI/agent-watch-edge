# AgentWatch Edge — Architecture

Status: implementation blueprint (written before code, per project process).
Date: 2026-08-07. Sections 1–10 are that blueprint. Anything numbered above it is a
dated addition written after the code it describes.

Every provider-specific claim below is tagged:

- **[docs]** — verified from current official documentation/source (August 2026).
- **[ref]** — verified from the reference repository `o11y-dev/opentelemetry-hooks` (v0.14.0).
- **[assumption]** — assumption requiring validation.

---

## 1. Reference repository analysis

`o11y-dev/opentelemetry-hooks` (MIT-declared, Python, ~6k-line single module + bash installer) connects
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
- **Privacy: developer prompts never collected; tool content off by default.** Raw prompt/response
  text is dropped at the adapter under every configuration — there is no flag for it — and replaced
  by `length` + `sha256`; the HTTP boundary strips any text an older release queued. Git remotes emitted only as a SHA-256 of the normalized,
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

- **Source A — hooks**: agent invokes `agentwatch hook --agent <id>` with JSON on stdin. Hook
  lifecycle events are an internal assembly format used to build `turn.summary`; raw
  session/tool/subagent events are never product records.
- **Source B — native OTel**: `agentwatch setup` writes each agent's *official* telemetry
  configuration so the agent exports per-request logs and multi-agent traces. The backend
  normalizes completed requests to `llm.call`, durably upserts them, and finalizes the token,
  cost and per-agent fields of `turn.summary`. Claude transcript totals are provisional only.

Only Source A is synchronous — the agent waits for the hook process to exit — which
makes it the only channel a turn can be refused on. See §11.

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
  core/                      # env.ts (injectable HOME/env), logger.ts (stderr-only), version.ts, which.ts
  events/                    # canonical-event.ts (types), event-id.ts, enrich.ts (git + path rewrite)
  providers/                 # provider.ts (interfaces), registry.ts, shared/ (tool classification)
    claude/                  # detect, hooks install/uninstall, adapter, otel configurator
    codex/                   # detect, hooks install/uninstall, adapter, otel configurator
  turns/                     # turn-state.ts, turn-tracker.ts, turn-summary.ts, claude-transcript.ts
  billing/                   # billing-mode.ts (subscription vs api detection)
  git/                       # git-context.ts (execFile git, timeouts)
  feature/                   # ticket-candidates.ts (branch → ticket evidence)
  privacy/                   # sanitizer.ts, secret-patterns.ts
  transport/                 # transport.ts, http-transport.ts, queue.ts, delivery.ts, cooldown.ts
  config/                    # config.ts (schema), config-store.ts, repo-config.ts (.agentwatch.json)
  enrollment/                # enrollment-provider.ts, manual-enrollment.ts
  storage/                   # paths.ts (XDG), atomic-file.ts, lock.ts, json-file.ts, install-state.ts
tests/                       # vitest; fixtures/ with realistic provider payloads
```

## 4. Public product schema (v1)

Exactly three public discriminators exist:

- `llm.call`: one physical provider request/completion with stable call id, model, usage, cost,
  session/turn/agent links, and joined Git/feature attribution.
- `turn.summary`: one prompt→final-response aggregate with `llm_calls`, final totals,
  `agent_usage[]`, and `usage_status`.
- `repo.snapshot`: bounded branch and commit metadata emitted when a repository
  changes and Git capture is enabled.

All canonical lifecycle types below are internal. The queue and transport accept only the
`ProductEvent = LlmCallEvent | TurnSummaryEvent | RepoSnapshotEvent` union, and re-apply the
current capture policy to every record on the way out — a queued record may predate a revoked flag.

As specified in the product brief, with these refinements:

- `session.providerId` preserved verbatim alongside a normalized `session.id` (same value for
  Claude/Codex; never invented).
- `ai.usage.source: "native_otel" | "hook_payload" | "transcript" | "unknown"` and
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
- **Native OTel**: mandatory via the settings.json `env` block:
  `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`,
  `OTEL_TRACES_EXPORTER=otlp`, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`,
  `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` (no default — must be explicit; JSON so the whole
  wire is one format),
  `OTEL_EXPORTER_OTLP_ENDPOINT=<otlp base>`. Bearer auth via the documented `otelHeadersHelper`
  settings key pointing at `agentwatch otel-headers` — the token stays in `~/.agentwatch`, never
  in Claude's settings. Each `claude_code.api_request` becomes one `llm.call`; `query_source`
  identifies main/subagent origin and `llm_request` traces add `agent_id` when available.

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
- **Native OTel**: `[otel]` contains both `exporter` (logs) and `trace_exporter`; aggregate
  metrics are disabled. `codex.sse_event`/`response.completed` and `codex.api_request` carry
  per-request usage. Traces carry `thread.id`, `turn.id` and multi-agent spawn links, so child
  thread usage remains separate from the root agent.
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
`<base>/v1/events` for turn summaries, `<base>/v1/otlp` as the OTLP base (standard OTLP/HTTP
paths append `/v1/metrics`, `/v1/logs` and `/v1/traces`; Claude aggregate metrics remain enabled
as a compatibility path, while Codex aggregate metrics are disabled in its `[otel]` block).
The Edge does not convert or proxy OTLP; agents export directly. Ownership tracking: everything
we write is recorded in `~/.agentwatch/install-state.json` so uninstall removes exactly what we
added (with match-by-marker fallbacks).

## 8. Correlation strategy

| stream | Claude Code | Codex |
|---|---|---|
| hook | `session_id`, `prompt_id`, `tool_use_id`, `agent_id` | `session_id`/`thread_id`, `turn_id`, `call_id` |
| native OTel | `request_id`, `session.id`, `prompt.id`, `query_source`, trace `agent_id` | response/request id, `conversation.id`, `thread.id`, `turn.id`, spawn edges |

The backend never drops usage because an agent instance id is absent: the call stays in the turn
total and degrades only to an agent-type or `unattributed` group. Calls are idempotent by
`(provider, call_id)`; summaries by `id`.

## 9. Setup flow

1. Resolve Git context (never fails hard outside a repo).
2. Detect agents: config dirs (`~/.claude`, `~/.codex`, project `.claude`/`.codex`) + executables
   on PATH (`claude`, `codex`) + existing hook registrations.
3. Prompt for backend URL (skipped when `--endpoint` given or config exists); optional token.
   Endpoint handling sits behind `EnrollmentProvider`; MVP ships `ManualEnrollmentProvider`, and a
   future `RemoteEnrollmentProvider` (`agentwatch setup <enrollment-url>`) slots in without
   changing setup.
4. Per detected agent: install hooks (merge, idempotent, backup + atomic write + post-write
   validation) and configure native OTel where the requested signals are safe under explicit
   global tool-content consent. Native prompt logging is always forced off, and Gemini traces
   (which can carry prompts) are never configured. Codex and Gemini usage logs remain off in
   metadata-only mode because current provider logs can contain tool arguments/results.
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
6. Claude request-log attributes and Codex `[otel]` request/span shapes are current today but
   explicitly versioned nowhere — pinned in per-provider modules, covered by doctor, documented
   in README.
8. End-to-end no-loss depends on the external OTLP receiver persisting each request before it
   acknowledges the exporter. The edge can require and diagnose export, but cannot make a
   non-durable receiver lossless.
7. Windows support: paths module isolates XDG/APPDATA decisions; hooks themselves are
   shell-command based and untested on Windows in this MVP (documented limitation).

## 11. Enforcement **(added 2026-09-19, after the code)**

Detailed design: `docs/superpowers/specs/2026-08-26-llm-block-enforcement-design.md`
(status: implemented; counterpart in `agent-watch-core`). Configuration and behaviour:
README, "Budget enforcement". Neither states what the two sources of §2 imply about
enforcement, which is what this section is for.

### Only one source can refuse anything

The two telemetry sources are not interchangeable, and enforcement is where the
difference becomes structural: **the agent waits on exactly one of them.**

| | Source A — hooks | Source B — native OTel |
|---|---|---|
| Carries | lifecycle events, `turn.summary` | `llm.call` — the usage ledger |
| Transport | stdin/stdout of one `agentwatch hook` process | the agent exports directly to the backend (§7) |
| Agent blocks on it | yes, until the process exits | no, fire-and-forget |
| Can refuse a turn | yes | never |

A refusal can only travel back down a channel the agent is waiting on, so the hook
path is the only enforcement point the Edge has. Source B cannot block by
construction: by the time a request log exists, the request has been made and
billed. This is FR-14's "passive telemetry collection must not claim to block AI
traffic" as it lands in this codebase.

### A cap depends on both sources

The loop crosses them in opposite directions:

1. Source B reports what was spent (`llm.call`, agent → backend).
2. The backend resolves that against the policy and answers
   `GET /v1/enforcement/decision`.
3. Source A asks that question at prompt-submit, and refuses the turn.

A cap is therefore only as good as the ledger feeding it — which is why
`enforcement`, `delivery` and `otel` are whole blocks in `GLOBAL_ONLY_BLOCKS` and
`emit.llmCalls`/`emit.turnSummaries` are in `GLOBAL_ONLY_EMIT_KEYS`. A committed
`.agentwatch.json` that silenced the usage ledger would defeat every cap in the
tenant as completely as one that turned the gate off, and far less visibly.

The global off switch (`agentwatch off`) short-circuits before the pipeline, so it
disables enforcement along with hook collection at once; `doctor` reports that as an
explicit budget-enforcement warning rather than leaving it silent. Source B does not
stop at once everywhere. Claude Code asks `agentwatch otel-headers` for its bearer,
which answers `{}` once the Edge is off, though batches already queued may still
leave. Codex and Gemini were given static credentials at setup and keep exporting
until they are restarted or closed.

### Gateability is per provider, and is not observability

Whether a provider can be gated depends on its hook protocol documenting a
refusal; whether its spend can be measured depends on it having an OTel exporter
that is switched on. The two are independent, and Antigravity currently has neither:

| Provider | Gated (Source A) | Ledger (Source B) |
|---|---|---|
| Claude Code | yes — `UserPromptSubmit` **[docs]** | native OTel |
| Codex | yes — `UserPromptSubmit` **[docs]** | native OTel, only with tool-content consent; the default metadata-only install leaves it off |
| Gemini CLI | yes — `BeforeAgent`/`UserPromptSubmit` **[docs]** | native OTel logs, only with tool-content consent; without it only metrics, and only when `otel.metrics` is on (off by default), so a default install exports nothing |
| Cursor | IDE sessions only — `beforeSubmitPrompt` **[docs]**; the CLI emits shell hooks only, so it is not gated | **none** — no OTel export, and transcripts carry no token usage, so summaries stay `usage_status=pending` |
| Antigravity | **no** — `PreToolUse` can deny mid-turn work, and a mid-turn tool gate is what the design rejected; `Stop` also takes a decision, but only `{"decision":"stop"}` | **none** — no OTLP exporter configuration exists |

So "enforced" is a property of a (provider, source) pair, not of the product. A
missing ledger and a missing gate fail differently. Cursor IDE, and Codex or Gemini
without consent, still ask and still refuse a developer the platform already knows
is over cap; what they lack is the spend that would move them over it. Cursor CLI
and Antigravity cannot refuse at all. Both failures are quiet: without a ledger,
the spend that should cross the cap goes unmeasured, and without a gate, a developer
already over it keeps working.

Under multi-tenant `roots` the ledger follows the root only on Claude Code. The
hook applies the root's token before it asks. Claude Code's exporter gets its bearer
per directory from `agentwatch otel-headers`, so a root sharing the machine's
collector is billed to its own tenant, and a root enrolled against another backend
gets no bearer at all. Codex and Gemini keep the machine token and endpoint written
at setup, so on them a root with its own token asks about a cap its own usage never
reaches.

### Cost on the critical path

The gate sits between the developer's keystroke and the agent's first token, so
every part of it is bounded. `enforcementWouldAsk` is consulted before any
gate-specific work (identity, checkout, model, cache, network), but it only asks
whether enforcement is configured (enabled, a token, a decision URL), not whether
the tenant has a cap: an enrolled machine pays for the question even when the
answer will be "no cap". Config loading and event parsing happen before it either
way. Identity, checkout and model resolve
in one `Promise.all`. The decision request is bounded by `enforcement.timeoutMs`,
300 ms by default; the config accepts a larger value, and the hook then waits that
long, up to the 30-second hook timeout setup registers with the provider, which
kills the hook first. A disk cache keyed on the whole question (endpoint, token, developer,
repository and branch, model) means each distinct question costs one bounded
request per TTL, as a best effort: cache and breaker writes swallow filesystem
errors, and concurrent hooks take no lock, so an unwritable data directory or two
simultaneous misses cost extra requests. Process-per-hook is why that cache exists on disk at all:
there is no memory to hold "this developer is allowed" between prompts. The same
reason puts the breaker on disk: a failed request is never cached as an answer, it
opens a cooldown, and until it expires the turns after it fail open (`circuit_open`)
without paying the timeout again.

What travels on the question has grown past the spec's single `developer_id`:
`repository` + `branch` when they can be resolved cheaply (both or neither, which is
what lets a feature-scoped cap be judged), and `model` when one is known. All of
them are part of the cache key, so an answer earned on one branch or model is never
served for another. A feature-scoped cap still makes the platform answer
`cache_ttl_ms: 0`, so feature spend is re-checked on every prompt rather than
trusted for a TTL.

### Trust boundary

Every mechanism here is a config file in the developer's home directory, honoured
by an agent that chose to read it. It can be edited, and the Edge can be
uninstalled. MDM (`examples/mdm/`) installs the package everywhere, but only Claude
Code has a managed policy file a non-admin cannot override; for Codex, Cursor,
Gemini and Antigravity, setup still writes user-owned hook files the developer can
remove. Even the managed file does not survive a developer who is a local
administrator. Nothing here survives an adversary, and the spec says so at more
length.
