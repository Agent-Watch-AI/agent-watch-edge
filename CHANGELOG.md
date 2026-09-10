# Changelog

## 0.3.0

- **Backlog migration requires an existing exclusive identity.** A new root
  inherits no machine/parent backlog; a shared token's queue stays in place.
  Collector warnings use the same effective-route check as the credential
  helper. Doctor explicitly fails when a configured identity has no budget
  decision route, including a refused root endpoint.

- **Delivery follows one ordered flow:** choose whether to send, attempt,
  preserve unsent records, update diagnostics, then drain or sweep the queue.
  A thrown transport error or 2xx response with failed events keeps the records
  for retry with their original IDs. The receiver must deduplicate retries.
- **One network budget per delivery pass.** Direct delivery, backlog sends and
  isolation probes share `delivery.timeoutMs` (1,500 ms by default). Deferred
  requests consume no retry attempts and do not trip backend cooldown. A 401/403
  during isolation stops further probes and persists the credential block.
- **Response cleanup is bounded.** Unread bodies are cancelled, including
  oversized declared responses and diagnostic probes; readers release their locks.
- **Linux and macOS are checked on Node 20 and 24.** CI also publishes repeatable
  hook/queue timing reports. Windows and managed-fleet rollout remain separate
  verification work.

Production-installation readiness. Everything below either changes what an
operator sees or what the package does on the hook path; read the first two
items before upgrading a fleet.

- **A refused credential now suspends sending instead of retrying.** After a 401
  or 403 from the events endpoint, a block is persisted per (destination,
  credential fingerprint) — the fingerprint is the token digest the queue
  already uses to name its partition, never the token — and automatic sends for
  that pair stop. **The refusal does not discard queued records**: normal age and size
  retention limits still apply; what stops is the retrying, not the queueing, and no attempt is spent against an entry for a
  refusal that is not its fault. The block never expires on a timer. It is
  lifted by configuring a different token, or by `agentwatch doctor` proving the
  current one good. `agentwatch status` reports the refusing status and when the
  refusals started.
- **`agentwatch doctor` diagnoses the install, not an anonymous request.** The
  backend probe now sends the same credentials a real delivery sends, and
  distinguishes four states in its verdict and its exit code: healthy, credential
  rejected (a **failure**, not a warning, naming a wrong, expired or revoked
  token), unreachable, and no backend configured yet. A healthy install whose
  backend requires authentication no longer warns. The probe always asks the
  backend, whatever local state says, so it is also what lifts a standing block.
- **A delivery pass costs the same whatever the backlog holds.** One pass reads
  at most `delivery.drainBatchSize` queue entries instead of reading and
  validating all of them — up to 2000 file reads on every hook during a backend
  outage. The scan resumes where the previous one stopped and wraps around, so
  every entry is still examined within one rotation and none is deferred
  forever. Expiry is no longer enforced only inside a pass: a throttled sweep
  removes aged-out entries hourly, including during an outage, when a pass is
  skipped for the whole cooldown window and nothing used to age out at all.
- **A hook loads one agent, and reads its configuration once.** Providers are
  imported lazily, so a hook pays for the agent it was invoked for rather than
  all five; the global configuration file is read once per invocation; the
  credential scrub and capture gate are applied once to a record this invocation
  produced (a record coming out of the backlog is still re-gated against current
  settings before it is sent); the session-state sweep is throttled; and the
  transcript settle loop stops re-zeroing its read buffer on every attempt.
- **The hook's answer is flushed before the process exits.** A budget refusal
  travels as a JSON document on stdout, and a write to a pipe is asynchronous:
  `process.exit` could drop it, which for Antigravity reads as "no decision".
- **Secrets in object keys are scrubbed.** The sanitizer pattern-scrubbed values
  only, so a credential used as a *key* in a captured map was transmitted
  verbatim. Two keys that scrub to the same string keep distinct spellings
  rather than silently merging into one entry. Redaction also runs *before* the
  length cap rather than after it: a credential straddling the 64KiB boundary
  was cut short first, so no pattern matched it any more and the surviving
  prefix shipped in the clear — for a JWT, a header and payload that decode to
  the claims the sanitizer exists to withhold. The URL-credentials pattern is
  bounded, which is what makes scrubbing the whole string affordable; unbounded,
  it cost 1.8s of CPU on a single 64KiB prompt, on the hook path.
- **A backend URL is validated on every load, not only when setup writes it.**
  Every URL in the configuration must be `https:`, or `http:` to loopback, so a
  hand-edited or MDM-templated config cannot send a bearer and captured content
  in cleartext. An offending URL is *refused* and named — on stderr from the
  hook, and by `status` and `doctor` — rather than invalidating the whole file:
  a failed parse falls back to a config with no token, which orphaned the
  existing backlog under a partition nothing would drain again, and one bad URL
  in one `roots[]` entry would have stopped delivery for every other project on
  the machine. A refused field reads as "configured but unusable" and never as
  absent — through `endpoint`, `eventsUrl` and `otlpUrl` alike. A `roots[]`
  entry that names a backend of its own now takes its routes from its own fields
  or from none: the machine's `eventsUrl` and `otlpUrl` are explicit strings
  that used to win before a root's own `endpoint` was ever consulted, so one
  tenant's prompts reached the other's ingest under the first tenant's bearer
  whether or not a refusal was involved, and `otel-headers` handed that bearer
  to the machine-wide collector. An entry that repeats the machine's endpoint —
  a second seat on the same backend — still inherits its routes and its bearer. `enforcementUrl` is the one
  accessor a refusal deliberately does *not* make unusable: no decision URL means
  `ALLOW`, so a typo there would switch every `block` cap off silently, and the
  derived route is a path on an already-validated `https:` endpoint.
  `setup` names a refused URL and leaves the line the developer wrote exactly
  where it is: the value is carried over the write from the file rather than
  replaced by the parse, re-enrolling merges into the entry instead of replacing
  it, so refused fields survive until repaired and another tenant's typo does
  not block setup. A route override survives a run that leaves the destination
  where it was (including trailing-slash normalization) and is dropped by one
  that moves it or cannot establish the previous destination — for a `roots[]` entry and
  for the machine identity alike, so winding one engagement down and enrolling
  the next no longer keeps POSTing to the first one's ingest under the second
  one's bearer. Every cleared live route is printed before the write, including
  during endpoint repair. The same rule includes machine `enforcementUrl`; a
  foreign root derives enforcement from its own base. Root token rotation keeps
  its stored backend when `--endpoint` is omitted, and backlog migration asks
  about the selected identity's queue. `config` warns about unavailable root
  routes and `doctor` names refused endpoints explicitly. `setup` still refuses a non-deliverable `--endpoint` outright.
  Response bodies the hook decodes are capped, and neither the batch send nor
  the enforcement check follows a redirect — both carry a bearer.
- **`status` and `doctor` act as the identity of the directory they run in.**
  Both read the machine-global token where the hooks in a `roots[]` project use
  that root's own. A 401 inside such a project raised a block under the root
  credential's fingerprint that `status` could not see and `doctor` could not
  lift — it probed the global token, and a 2xx cleared a block that was never
  the one standing — leaving that project's telemetry suspended, with no timer
  to end it and no diagnostic naming it.
- **Retention holds on the paths that never send.** The whole-partition sweep ran
  inside a delivery pass, and both skips — a tripped cooldown and a refused
  credential — return before one. A revoked token therefore aged nothing out for
  as long as the block stood, while the queue bound quietly shed the oldest
  entries at the ceiling without counting them, so `status` reported nothing
  lost. The sweep now runs on every path that skips a pass — including the one
  where no usable endpoint is configured, which a refused URL makes a durable
  state rather than a pre-setup one — its hourly throttle is read from the clock
  the marker is written in (an injected or backward-stepped clock silenced it
  permanently), and the bound reports what it sacrifices.
- **Every registered agent is loadable.** The eager provider list and the lazy
  loader map are two hand-maintained lists of the same agents; a test now asserts
  they agree. An agent in only one of them installed hooks that resolved no
  provider on every invocation and dropped all of that agent's telemetry, while
  `setup`, `status` and `doctor` all reported success.
- **A degraded turn summary is attributed to the same developer as a healthy
  one.** On a machine that takes its identity from git rather than from
  configuration, a summary emitted after turn assembly failed carried no
  developer at all: counted in organization totals, in nobody's budget.
- **Agent config files are no longer permanently tightened.** `0600` is set only
  when the block being written actually carries a bearer token, and `uninstall`
  restores the mode the file had before AgentWatch touched it.
- **Supply chain.** Actions pinned by commit SHA, `npm ci --ignore-scripts` in
  the job that builds the published tarball, `npm audit --omit=dev
  --audit-level=high`, CodeQL on every change and weekly, grouped weekly
  Dependabot updates, and a CI matrix over Node 20 and Node 24 so the declared
  floor is verified rather than declared. Coverage is measured with enforced
  per-directory thresholds for the privacy, enforcement, transport and turn
  paths.
- **Fewer moving parts.** Dead exports deleted and the compiler set to reject
  unused locals and parameters; enrollment collapsed from four files and an
  interface to one function; one definition each of the content-capture flag
  list, the product-record guard and the hook-command quoting patterns.

### Earlier changes, never published, shipping in 0.3.0

- **Content capture is now off by default.** `capture.prompts`, `capture.responses`,
  `capture.toolInput` and `capture.toolOutput` default to `false`: a fresh install collects
  metadata only, and shipping prompts or tool I/O off the machine is a deliberate opt-in.
  `capture.git` and `capture.files` stay `true` — they gate the repo remote/branch/SHA and the
  per-file *path*, which is what feature and project attribution is built from, not content.
  `prompt_evidence`/`response_evidence` (length + SHA-256, never the text) are unaffected, so turn
  counts and cost attribution work with capture fully off.
- **Content capture also requires explicit consent.** A new global-only `contentCaptureConsent`
  marker gates the four content flags: a config carrying `prompts: true` without it collects
  nothing, so replacing the npm package cannot silently carry an older install's decision forward.
  The gate is applied on every read and never written back, so a machine that adds the marker later
  turns its existing flags back on instead of finding them erased; setup names the flags that are
  set but inert. The gate lives in the config schema, so it also reaches records that
  were queued before the policy changed — a summary loses text whose flag is off, and a
  `repo.snapshot` is dropped whole once `capture.git` is off.
- **Native exporters are gated separately.** Provider logs are not filterable per field, so Codex
  and Gemini usage logs are configured only with consent for both tool flags, Gemini detailed
  traces additionally require prompt and response capture, and Claude's own content-logging
  switches are forced off. This can leave `llm.call` usage unavailable for Codex and Gemini in
  metadata-only mode. Rerun `agentwatch setup` after upgrading and restart your agents: nothing
  about replacing the CLI changes an exporter already live inside a running agent.
  `~/.gemini/settings.json` is now written `0600` — it carries a static bearer token.
- **`agentwatch off` / `agentwatch on`.** A local marker stops hooks before stdin, withholds the
  OTLP authorization header, and removes managed native exporters through the same ownership and
  backup machinery as uninstall — keeping config and queued data. Failures keep the marker, and a
  repeated `off` re-runs the removal. Restart running agents to make it take effect.
- `agentwatch doctor` now probes the hook command each provider actually has installed: it never
  runs the stored shell string, only a verified CLI with a bounded `--version`, and it reports
  consent, capture and off-switch state.
- Release: `npm run release:artifacts` packs a verified tarball, a production-only CycloneDX SBOM
  and `SHA256SUMS`. Publishing is an explicit `workflow_dispatch` on `main` through npm trusted
  publishing with `--provenance`. New [docs/DATA_HANDLING.md](docs/DATA_HANDLING.md) states the
  collection contract; [docs/ENTERPRISE_DEPLOYMENT.md](docs/ENTERPRISE_DEPLOYMENT.md) states what
  is deliberately not built.
- MDM deployment templates in `examples/mdm/`: a Jamf/Kandji script, an Intune script, and a
  Claude Code `managed-settings.json` policy file, with a per-agent table of what an
  administrator can and cannot lock. `agentwatch setup` now also reads the enrollment token
  from `AGENTWATCH_TOKEN`, because a policy running as root has no private channel other than
  the environment and `--token` is visible to `ps`. The flag still wins.
- A committed `.agentwatch.json` can now only ever *narrow* capture. A repository file that sets a
  capture flag the machine has off is ignored and reported — `agentwatch config` and
  `agentwatch doctor` both print the refusal — so checking a repository out can never start
  collecting content on someone else's machine. The `capture` block also drops unknown keys instead
  of passing them through.

- `agentwatch setup` now refuses an install it cannot attribute: with no `--developer-email` and no
  `git config user.email`, it exits non-zero with the two remedies on stderr and writes no config
  file. An unknown identity is allowed silently by the enforcement gate, so an unattributable
  install used to report success while enforcing nothing.
- `--yes` / `--non-interactive` now suppresses every setup prompt, including the developer-email
  one, and the prompt itself only appears when nothing else names the developer. `--developer-email`
  still overrides the machine's git identity.
- `agentwatch doctor` reports the same condition as a `developer identity` failure, in the human
  report and in `--json`, so a scripted rollout can fail a machine instead of shipping it broken.

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
- The gate now also states the session's model (`&model=…`), so a budget can be set on one model.
  Codex, Cursor, Gemini and Antigravity name their model on every hook they send; Claude Code
  names it only when a session starts, so that one event remembers it in a `session.json` beside
  that session's turn records (mode 0600, in a directory named by a hash of the session id, never
  by the id itself) and it is cleared with the rest of the session at SessionEnd, or by the
  24-hour sweep for a session that crashed. A session that starts naming no model forgets any
  model remembered under that id rather than inheriting it. It is spelled as the agent names it,
  which for every agent but Claude Code is the same event the reported usage comes from. The model is part of the local cache key, so an answer about one model
  is never reused for a prompt on another. The added cost is that one file read: no subprocess, no
  extra request, and an unreadable memo states no model rather than waiting. A collector that never
  learns a model asks exactly what it asks today and is answered exactly as today.

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
  <https://github.com/agent-watch-ai/agent-watch-edge>.
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
