# Changelog

## Unreleased

- BREAKING: the public model now has exactly two records: atomic `llm.call` and aggregate
  `turn.summary`. Raw hook lifecycle events, telemetry opt-out flags, and offline drop policies
  were removed.
- Native OTLP signal selection is configurable: `otel: {logs, traces, metrics}` in the global
  config, or `agentwatch setup --otel <all|none|logs,traces,metrics>`. The default exports logs
  only — the per-request usage/cost ledger behind `llm.call`; traces (TTFT/subagent attribution)
  and metrics (active time, aggregates) are opt-in. `--otel none` removes the agents' telemetry
  config entirely. The selection is global-only: a committed `.agentwatch.json` cannot change it.
  Setup still fails on exporter conflicts, and doctor fails when per-request coverage is missing.
- Added exported TypeScript contracts, OTLP/JSON normalization, idempotent call aggregation,
  `usage_status`, `llm_calls`, `cost_usd`, and per-agent `agent_usage[]`.
- Delivery and queue APIs accept only `ProductEvent` and retain both types.

- Fix: the first entry of `files_changed` no longer loses its leading character
  (`CHANGELOG.md` arrived as `HANGELOG.md`) — the git runner trimmed the significant leading
  space off the first `status --porcelain` line.

- Correctness: transcript usage allocation is serialized per session across the complete
  claim/read/settle/write transaction, then persisted by stable message id. This prevents
  double attribution for overlapping turns in any close order, including an equal-timestamp
  boundary; transcript entries without `message.id` use a stable content hash.
- Safety: hook ownership now parses quoted argv and accepts only the two forms setup installs:
  an `agentwatch` executable, or `node <agentwatch-install>/dist/cli.js`, immediately followed
  by `hook --agent <supported-provider>`. Compound commands and foreign executables are never
  claimed.

- Safety: repo overrides are ignored entirely while the global config is missing or corrupt —
  a committed `.agentwatch.json` cannot re-enable content capture over the fail-safe.
- Privacy: path rewriting inside captured content is boundary-aware (`/x/repo` no longer
  fires inside `/x/repository`); `git config user.email` honors the injected home, keeping
  tests and sandboxes away from the real global gitconfig.
- `agentwatch doctor` reports the privacy posture from the EFFECTIVE config for the current
  directory (repo overrides included), not the global one.

- Reliability: persisted circuit breaker for the direct send — after a failed delivery, hooks
  skip the send (and its 1.5 s timeout) for 60 s and queue events instead, so a dead backend
  costs at most one timeout per minute instead of stalling every hook.
- Safety: install/uninstall now own individual hook HANDLERS, not whole matcher groups — a
  user handler sharing a group with AgentWatch survives both operations; Codex uninstall
  preserves the top-level `description`.
- Safety: a missing or corrupt global config now fails safe to metadata-only capture at
  runtime (setup still writes full-capture defaults on a deliberate install).
- Privacy: captured tool input/output and shell commands get path prefixes rewritten
  (repo root → relative, home → `~`); `capture.files=false` now also drops per-file
  `filePath`/`files_touched`, not just Git changedFiles.
- Correctness: the turn-close lock is keyed by session+turn, so two different prompts of one
  session can close concurrently without losing a summary.
- Performance: transcript usage parsing reads only the last 4 MB of the JSONL instead of the
  whole file on every retry.
- Codex: `PreCompact`/`PostCompact` hooks are now registered.
- `agentwatch doctor` reports repo-config overrides and their warnings for the current
  directory.

- Robustness: turn closing is serialized per session (duplicate/racing Stops emit exactly one
  summary), records landing during the transcript settle wait are re-collected into the
  summary, and transcript usage is bounded by the Stop timestamp so a racing next prompt's
  tokens don't leak into the previous turn.
- `agentwatch doctor` verifies Claude Code >= 2.1.196 (required for `prompt_id` turn
  correlation) and warns when turn tracking would degrade to session-scoped.
- Correlation: Claude `prompt_id` now flows into `session.turnId` on every event of the turn
  and into `turn.summary.turn_id`, matching OTel `prompt.id` — context and provider cost can
  be joined precisely (`session_id` + `turn_id`).
- Turn state is prompt-scoped: Stop consumes only records of its own prompt (racing next-turn
  records survive for their own Stop), and a repeated Stop with nothing new emits no empty
  duplicate summary.
- Security: legacy queue entries without a recorded destination are quarantined instead of
  being grandfathered into the next configured backend; pre-setup entries are explicitly
  marked for the first backend `setup` configures.
- Security: `developerEmail` is global-only — a committed `.agentwatch.json` cannot spoof
  developer attribution.
- Accuracy: transcript usage reads honor a settle window (500 ms) so early-stable usage in
  multi-tool turns doesn't end the read before the final entry lands.
- Billing detection no longer guesses: unrecognized Claude `billingType` values report
  `unknown` instead of `api`.

- Security: `endpoint`/`eventsUrl`/`otlpUrl` are global-only — a committed `.agentwatch.json`
  can no longer redirect telemetry (and the global bearer token) to a repo-controlled
  backend.
- Security: offline queue entries are pinned to the events URL they were queued for; after
  an endpoint change, old entries are never replayed to the new backend (they wait for
  their own backend or expire).
- Privacy: turn-state files (raw prompt/response text) are written with mode 0600, and
  orphaned session state (crash without Stop/SessionEnd) is swept after 24 h.
- Accuracy: transcript usage reads now wait for a stable snapshot (two consecutive
  identical reads) instead of stopping at the first usage entry, so late-flushed final
  entries in multi-tool turns are not undercounted.
- Example backend: OTLP responses now echo the request encoding (JSON in → JSON out), as
  the OTLP/HTTP spec requires.
- Capture defaults flipped to full capture: `capture.prompts/responses/toolInput/toolOutput`
  now default to `true` so turn summaries carry prompt/response text and tool I/O out of the
  box; each category can still be disabled per machine or per repo. The secret sanitizer
  applies regardless.
- Reliable token usage on `Stop`: Claude Code flushes its transcript asynchronously, so the
  final assistant entry could be missing when the hook read it, dropping `model` and
  `*_tokens` from the summary. Usage reads now retry (up to 6 attempts, 250 ms apart) until
  the entry appears.
- Billing mode detection: turn summaries carry `billing_mode` and the `generation.completed`
  event carries `ai.billingMode` — `subscription` (Claude Pro/Max seat, ChatGPT plan) vs
  `api` (per-token billing: `ANTHROPIC_API_KEY`, Bedrock/Vertex, Codex API key). Detected
  from the agent's local auth state (`~/.claude.json` `oauthAccount.billingType`,
  `~/.codex/auth.json` `auth_mode`); degrades to omitting the field when undetectable.
- Everything on the wire is JSON now: native OTel export switched from binary protobuf to
  OTLP/JSON for both agents (Claude Code `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, Codex
  `protocol = "json"`). The example backend pretty-prints OTLP/JSON log records (event name,
  session, model, tokens, cost) and metric names.
- Turn summaries: one flat `turn.summary` event per prompt→response turn, emitted on `Stop`.
  Carries developer email, repo/branch/commit, Jira ticket ids from the branch name,
  prompt/response (per capture flags), tool-call counts and touched files. Transcript usage is
  provisional until the backend finalizes it from `llm.call` rows.
- `agentwatch setup --developer-email <email>` and interactive prompt (defaults to
  `git config user.email`); stored as `developerEmail` in `~/.agentwatch/config.json`.
- New `emit` config block: `{ "turnSummaries": true, "llmCalls": true }`; `llmCalls` is
  mandatory and repo overrides cannot disable it.
- Per-repository configuration: `.agentwatch.json` in the repo root overrides the global
  `~/.agentwatch/config.json` (scalars replace; `capture`/`emit`/`delivery` merge per field;
  `token`/`installationId`/`endpoint`/`eventsUrl`/`otlpUrl` are global-only and ignored).
  `agentwatch config` now prints the
  effective merged configuration.
- CLI: `--non-interactive` alias for `--yes`; `--help` documents every flag and the
  configuration layers.
- Offline delivery retains every product record it receives; there is no drop policy.

## 0.1.0 (2026-08-07)

Initial MVP.

- CLI: `setup`, `status`, `doctor`, `uninstall`, `hook`, `agents`, `config`, `otel-headers`.
- Providers: Claude Code (hooks in `~/.claude/settings.json`, native OTel via env block +
  `otelHeadersHelper`), OpenAI Codex (hooks in `~/.codex/hooks.json`, native OTel via managed
  `[otel]` block in `config.toml`).
- Canonical event schema v1 with provider-independent event types and deterministic event IDs.
- Git enrichment (repo, hashed credential-free remote, branch, commit, changed files) and
  ticket-key feature candidates from branch names.
- Privacy-first capture defaults + recursive secret sanitizer.
- Offline-tolerant delivery: bounded file queue, exponential backoff, dedup by event ID.
- Idempotent, merge-only config writes with backups; uninstall removes only AgentWatch-owned
  entries.
