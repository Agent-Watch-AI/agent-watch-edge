# Changelog

## Unreleased

- Budget enforcement: before a turn starts, the Edge asks the backend
  (`GET <backend>/v1/enforcement/decision?developer_id=…`) whether this developer may make an LLM
  call, and refuses the prompt in the agent's own protocol when the backend answers `block` —
  Claude Code (`{"decision":"block","reason":…}`), Codex (`{"continue":false,"stopReason":…}`),
  Cursor (`{"continue":false,"user_message":…}`) and Gemini CLI (`{"decision":"deny","reason":…}`).
  The backend's sentence is what the developer is shown. Antigravity has no prompt-level refusal
  contract and is not gated.
- The check fails open in every other case: not configured, `enforcement.enabled: false`, no
  developer identity, a 300 ms timeout, a network error, any non-2xx status, and any body that is
  not a `block` carrying a message. Exit code stays 0 throughout — a refusal travels in the hook
  protocol, never as a failed hook.
- Decisions are cached locally (`<dataDir>/enforcement-cache.json`, 60 s, keyed by a hash of URL,
  token and identity, mode 0600); failures are never cached. New config: the `enforcement` block
  (`enabled`, `timeoutMs`, `cacheTtlMs`) and the `enforcementUrl` override, both global-only.
- A refused prompt records no turn state — it never reached a model — while the offline queue still
  drains on that hook. `agentwatch status` reports whether enforcement is on, and the example
  backend gained the route (`BLOCK=1 npm run example` refuses everything).

## 0.2.0

- Package/documentation: public helpers now ship TypeScript declarations, and the
  README clearly separates sanitized hook summaries from direct native OTLP traffic
  and provisional summaries from backend-finalized usage.
- Example backend: malformed OTLP/JSON payloads now return `400` instead of being
  acknowledged and silently dropped; only the documented logs, traces and metrics
  endpoints are accepted, and the example is included in the npm package so its
  published `npm run example` script works.
- Cursor support: new `cursor` provider — lifecycle hooks in `~/.cursor/hooks.json`
  (sessions, prompts, tools, shell, MCP, file edits, subagents, compaction, accepted tab
  edits), `conversation_id`/`generation_id` as session/turn correlation, and turn
  summaries with prompt, response, tools, files and git context. Cursor has no OTel
  export and no usage in hooks or transcripts yet, so its summaries stay
  `usage_status=pending`; the bundled transcript reader picks up tokens automatically
  once Cursor enriches the format. `agentwatch doctor` reports both limitations (the
  pending usage and the cursor-agent CLI emitting only shell hook events).
- Turn state gained a `response` record kind: providers that deliver the response text
  outside the Stop event (Cursor's `afterAgentResponse`) still produce summaries with
  the response; a Stop-supplied response keeps priority.
- BREAKING: `aggregateTurnUsage` marks a turn `usage_status=complete` only when the
  caller passes `complete: true` — an explicit terminal signal (watermark / quiet
  period / session end). OTLP batches arrive asynchronously and are retried, so the
  previous default (`complete` on the first non-empty batch) could stamp completeness
  while late batches were still in flight; without the signal the result is `partial`.
- BREAKING/semantics: `turn.summary.files_touched` now contains only files the agent's
  tools MODIFIED, as documented; files that were only read moved to the new
  `files_read` field. (Legacy turn-state records without an access marker stay in
  `files_touched`.)
- Fixed: `agentwatch setup --otel <signals>` was silently ignored — `--otel` was
  missing from the CLI's value-flag list, so its value parsed as a stray positional.
  Argument parsing moved to `src/cli/args.ts` and is covered by tests.
- Cursor: tool calls covered by dedicated hooks (shell, MCP, file read/edit) are no
  longer double-counted — Cursor fires both the generic `postToolUse` and the dedicated
  hook for the same invocation, and only the dedicated hook now produces the completion
  record; generic completions remain for tools without a dedicated hook, and failures
  always flow through `postToolUseFailure`.
- Cursor: the transcript usage reader bails out after one read when the transcript
  carries no usage rows (today's format), removing ~1.25 s of retry/settle latency
  from every Cursor Stop; the settle loop still guards flushes once usage rows exist.
- Cursor: the structured `model_id` now supersedes the legacy `model` slug,
  `model_params` (thinking/context/effort selections) are preserved as structured
  `provider.modelParams`, and prompt attachments are recorded (count always, file
  paths gated by `capture.files`).
- Performance: hooks on the agent's critical path (tool events) resolve only the git
  repository root (one git process) for path rewriting; the full git context —
  branch, commit, remote, and the expensive `status --porcelain` — is collected only
  when a turn closes, where the summary actually consumes it.
- Durability: atomic file writes fsync before rename, so a crash right after the
  rename can no longer leave queue entries, config, or turn state truncated.

- BREAKING: the public model now has exactly two records: atomic `llm.call` and aggregate
  `turn.summary`. Raw hook lifecycle events, telemetry opt-out flags, and offline drop policies
  were removed.
- BREAKING: `aggregateTurnUsage` performs the time-window join only when
  `options.sessionSummaries` (the session's full summary set) is provided. Per-summary
  containment alone cannot arbitrate overlapping turn windows, so the previous no-context join
  could double-count the same call's tokens and cost across successive finalizations. Without
  the set, calls now match only through an exact turn id.
- Fixed `repository`, added `homepage` and `bugs` in `package.json` — now pointing to
  <https://github.com/alexrepetskyi/agentwatch>.
- Simplified README; product record examples now use mock data.
- Correctness: one malformed OTLP log record (e.g. an unparseable timestamp attribute combined
  with `duration_ms`) no longer throws and aborts normalization of the entire batch — the
  record is skipped and every other `llm.call` in the batch is still ingested.
- Correctness: ticket candidates are extracted from the branch name as-is instead of
  uppercasing it first, which fabricated Jira ids from ordinary words (`bump-node-20` produced
  `NODE-20`). Only keys that are uppercase in the branch itself are reported.
- Correctness: `turn.summary.model` now reports the model that produced the most tokens in the
  turn's transcript window instead of the last one written — a small subagent or
  title-generation side-call can no longer mislabel (and misprice) the whole turn.
- Correctness: on old Claude versions without `prompt_id`, two identical prompt submissions no
  longer collapse into one turn-state record (the second turn used to close with no summary,
  losing its prompt, tools, and token usage).
- Git: userless scp-like remotes (`github.com:org/repo.git`) normalize correctly instead of
  parsing as a URL scheme and being dropped; an scp userinfo with an embedded password is
  stripped before matching and can never leak into the normalized remote.
- Git: branch detection uses `symbolic-ref --short -q HEAD` instead of
  `branch --show-current`, which does not exist before git 2.22 and silently dropped branch
  and ticket attribution on older machines.
- Git: a `status --porcelain` output larger than 1 MB now yields a truncated `changedFiles`
  list (bounded by `maxChangedFiles`) instead of dropping the list entirely.
- Git: quoted porcelain paths (`core.quotePath`) are C-style-unescaped, so file names with
  non-ASCII or special characters appear in `files_changed` as real paths instead of
  `r\303\251sum\303\251.txt`-style escape strings.
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
