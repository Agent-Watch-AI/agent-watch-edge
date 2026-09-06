# Data handling contract

This document describes this repository revision, not every previously published
package. npm `0.2.5` enabled content capture by default. Review the installed
version and run `agentwatch config` and `agentwatch doctor` during deployment.
AgentWatch is a user-level, hook-only Node.js program. It does not install a daemon,
require root, proxy model requests, or enforce an administrator-proof policy.

## Defaults and upgrade consent

AgentWatch does not collect prompt text, response text, tool input bodies, or tool
output bodies through its hooks by default. Default capture is:

```json
{
  "contentCaptureConsent": false,
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

Old configurations with all four content flags explicitly `true` are interpreted
as metadata-only unless the global `contentCaptureConsent` marker is exactly
`true`. Neither loading nor `agentwatch setup` rewrites those four flags: the
gate is applied in memory on every read, so adding the marker later restores the
values already on disk rather than finding them erased. Missing, unreadable,
invalid, and corrupt global configuration do not authorize content capture. Git and file-path capture remain
enabled unless separately disabled.

Intentional opt-in requires editing the **global** `~/.agentwatch/config.json`:
set `contentCaptureConsent` to `true` and explicitly set each desired content
capture field to `true`. The marker alone does not enable fields that are false.
Set the marker to `false` to revoke consent. `config`, `status`, and `doctor`
report consent and capture state without printing captured content. Repository
`.agentwatch.json` files cannot grant consent, increase any capture field, alter
identity, redirect delivery, or change enforcement/delivery/native OTel settings.
They may reduce individual capture fields. Because loading gates the flags, the
next `agentwatch setup` persists the gated values, and prints which flags it is
about to save as `false` so that rewrite is visible rather than silent.

Current policy is reapplied to prompt and response text in old turn state before
queueing, and to every queued record before HTTP delivery: summaries lose text
whose flag is off, and repository snapshots are dropped entirely once `capture.git`
is off. Old files are not erased by an upgrade; their original content may remain
locally until consumed or expired. An intentional later opt-in can permit delivery
of retained queued text.

**Upgrade native telemetry separately:** rerun `agentwatch setup` after upgrading,
then restart every running coding agent. Existing native exporter configuration
and in-memory exporters do not change merely because npm replaces the CLI.
Use `agentwatch off` and close agents before upgrading if export must be stopped
during the transition. Setup explicitly disables native prompt logging and Claude
tool detail/content logging even when hook content capture is opted in. Codex and
Gemini usage logs can contain tool arguments/results without a reliable per-field
filter, so the Edge configures those logs only when global consent exists and both
`toolInput` and `toolOutput` are enabled. Gemini detailed traces additionally
require prompt and response capture. Gemini metrics may run without content
consent. This can leave `llm.call` usage unavailable by default for Codex and Gemini.

## Outbound records

There are three public event types, not a raw lifecycle or tool event stream:

| Type | Source and purpose |
| --- | --- |
| `turn.summary` | Edge hooks assemble one completed turn and send it to the events endpoint, or queue it. |
| `llm.call` | Agents export native OTLP directly. The backend/library normalizes supported completed request records into per-call usage. Edge does not proxy native OTLP. |
| `repo.snapshot` | Edge queues changed repository branch/commit metadata after a closed turn when Git capture is enabled. |

Generated records share `schemaVersion`, `id`, `timestamp`, `event.type`,
`event.providerEventType`, `agent.provider`, `agent.name`, session identifiers,
and optional `developer.installationId`. Absent fields are omitted. Provider
availability determines which identifiers and usage values exist.

### `turn.summary`

The hook-generated flat fields are `provider`, `surface`, `session_id`, `turn_id`,
`developer_id`, `repository`, `branch`, `commit`, `jira_ids`, `files_changed`,
`files_touched`, `files_read`, `prompt`, `prompt_evidence`, `response`,
`response_evidence`, `tool_calls`, `tools_used`, `model`, `billing_mode`,
`input_tokens`, `cached_input_tokens`, `cache_creation_input_tokens`,
`output_tokens`, `usage_status`, `started_at`, and `ended_at`. The nested `session`
contains `id`, `providerId`, and optionally `turnId`.

Only `prompt` and `response` carry raw conversational text, and only with consent
and their enabled flags. Evidence contains `length` and `sha256`; it is not raw
text, but hashes and lengths can still reveal information about guessable text.
Evidence is aligned to sanitized text when text is sent. Tool input/output capture
affects internal adapter data; current summaries transmit tool names/counts and
file paths, not tool bodies. Enabling tool flags does not add a tool event stream.

The public summary type additionally supports backend-derived `llm_calls`,
`agent_usage`, `reasoning_output_tokens`, `total_tokens`, and `cost_usd`.
`agent_usage` holds agent/parent/type identifiers, call count, token counts and
cost. Hooks initially report usage as `pending` or transcript-based `provisional`;
backend aggregation may mark it `partial` or `complete`.

### OTLP and `llm.call`

Normalized calls carry `provider`, `surface`, `call_id`, `provider_request_id`,
`provider_session_id`, `provider_turn_id`, `session_id`, `turn_id`, `agent_id`,
`parent_agent_id`, `agent_type`, `model`, `billing_mode`, `status`, `correlation`,
`input_tokens`, `cached_input_tokens`, `cache_creation_input_tokens`,
`output_tokens`, `reasoning_output_tokens`, `total_tokens`, `cost_usd`,
`duration_ms`, `started_at`, `ended_at`, and optional joined `repository`, `branch`,
`commit`, `jira_ids`. Common envelope fields and optional Git/feature attribution
also apply. These are identity, usage, timing and development metadata; the
normalized call schema does not include prompt/response text or tool bodies.

Native OTLP is a separate trust boundary: provider logs, resource attributes,
trace/span IDs, and optional traces/metrics reach the receiver **before** this
normalization. The Edge hook sanitizer and consent marker cannot filter that
traffic. AgentWatch does not claim the normalized schema describes every raw
OTLP attribute emitted by every provider version. Provider settings, ambient
environment, or custom exporters can change what is sent. Validate the actual
provider version and receiver filtering for a pilot; do not assume a backend
dropping a field means it never left the machine. Logs are requested by default,
but the content gate above can prevent their provider configuration; traces and
metrics default off. See [Claude telemetry](https://code.claude.com/docs/en/monitoring-usage)
and [Gemini telemetry](https://geminicli.com/docs/cli/telemetry/) for provider gates.

### `repo.snapshot` and Git metadata

Snapshots contain `provider`, `surface`, `repository`, optional `developer_id`,
`default_branch`, `captured_at`, and `branches`. Each branch has `name`,
`head_sha`, optional `last_commit_at`, and `commits`; each commit has `sha`,
`subject`, and optional `authored_at`. Lists and subjects are bounded by the
snapshot implementation. Git capture includes commit subjects, which can contain
sensitive business information even though they are classified as metadata.
Set global `capture.git: false` to disable new snapshots; already-queued snapshots
are then discarded at delivery rather than sent.

Remote URL userinfo is removed before normalization. Normalization yields
`host/org/repo`, omitting scheme, query, fragment and `.git` suffix. A SHA-256 hash
of that normalized identity is available for Git attribution. **Repository names
are not hash-only:** current summaries and snapshots send the normalized
repository identity, or the checkout basename when no remote is available.
Branches, commit SHAs, ticket keys and file paths are metadata, not anonymous data.
Paths are made repository-relative where possible; paths outside the repository
can remain absolute, with the home prefix abbreviated.

## Identity, local storage, and credentials

Developer identity is the configured `developerEmail`, falling back to Git email
resolution. Setup requires an identity. The email is sent as `developer_id` and
used for enforcement. It is not currently pseudonymized with a tenant HMAC.
An installation UUID also identifies the installation. Native providers may send
their own session/account/resource identifiers independently.

Global configuration and primary bearer token are stored in
`~/.agentwatch/config.json`; ownership records are in
`~/.agentwatch/install-state.json`. `AGENTWATCH_CONFIG_DIR` overrides this root.
The data root is `$XDG_DATA_HOME/agentwatch`, falling back to
`~/.local/share/agentwatch`. On Windows, when present, `%LOCALAPPDATA%/agentwatch`
is used; Windows deployment is not verified. `AGENTWATCH_DATA_DIR` overrides it.

The data root contains `queue/`, `turns/`, `backups/`, `locks/`, `snapshots/`,
`checkouts/`, delivery/cooldown/enforcement state, and `disabled.json` when off.
The queue contains sanitized product records and their destination, attempts,
and retry timestamps. Defaults are 2,000 events, 20 attempts, and 7 days.
Expiration is processed during activity, not by a daemon or scheduled erasure.
Capacity pressure removes oldest entries. Turn state has a 24-hour stale-state
cleanup bound, also activity-driven. Backups and other local caches have no
guaranteed automatic deletion deadline. The package does not delete provider-owned
transcripts; it can read them locally for usage attribution.

Config, queues, turn state and the off marker use POSIX mode 0600. Codex's managed
`~/.codex/config.toml` contains a static bearer token and is made 0600 when a token
is written. Gemini's `~/.gemini/settings.json` likewise contains static
`OTEL_EXPORTER_OTLP_HEADERS` and is written 0600. Claude uses `otelHeadersHelper`
to retrieve credentials from AgentWatch at runtime. Cursor and Antigravity have
no managed native exporter. Backups preserve source permissions and can contain
credentials, including historical copies. Other directories/files use existing
permissions or process defaults; POSIX modes are not a verified Windows ACL
guarantee. Local data is not encrypted by this package. Passing a token on the
setup command line can expose it through shell history/process inspection.

## Endpoints and failure behavior

The operator configures the backend; there is no hard-coded hosted destination.
Defaults derived from that endpoint are `POST /v1/events`, native OTLP base
`/v1/otlp` with `/v1/logs`, `/v1/traces`, `/v1/metrics` signal suffixes, and
`GET /v1/enforcement/decision`. Global `eventsUrl`, `otlpUrl`, and
`enforcementUrl` may override those routes. Authentication uses a bearer token
when configured. Use HTTPS in deployments; the schema does not prohibit HTTP.
Enforcement sends developer and checkout attribution, not prompt/tool bodies.
Doctor can probe connectivity with an empty events batch. Status can drain the
queue. Both stop network activity while disabled.

Hook errors return the provider's passive response/exit zero. Unknown inputs,
missing configuration, parser failures and unexpected exceptions must not crash
the coding agent. Direct sends have a default 1,500 ms timeout; failed records
are queued, with bounded retries and eventual loss reported by status. This is
not a guarantee of lossless delivery. Native exporter retry behavior is owned by
the provider, not the Edge queue. Sanitization is unconditional for Edge records;
it redacts known credential patterns/sensitive keys and bounds string/depth sizes.
Pattern matching cannot guarantee discovery of every possible secret.

Enforcement is fail-open on unexpected errors, timeouts, invalid responses and
unreachable services. A supported hook blocks only on an explicit backend block
decision. Defaults are a 300 ms request timeout and 60-second local decision
cache. Antigravity has no verified blocking response. This is not a local signed
enforcement policy or tamper-resistant control.

**The gate makes a network request.** Before a turn starts, the pre-prompt hook
reads a local decision cache and, on a miss, asks the platform — one bounded
request, 300 ms ceiling, every failure allowing the turn. Two consequences are
worth stating rather than leaving to be discovered. A platform outage does not
stop developers; it un-enforces every budget for as long as it lasts, which at
the default cache TTL means decisions go unmade for up to a minute past
recovery. And the cache is not always a saving: an organization with a
feature-scoped policy receives `cache_ttl_ms: 0` on every answer, because a
reuse key cannot distinguish one checkout from another, so those turns each pay
a request. A gate that evaluates a locally held policy without a network call is
planned; it requires the platform to send a policy rather than a verdict, and it
is not what ships today.

## Off, uninstall, and provider limitations

`agentwatch off` writes a local marker before changing native configuration.
Disabled hooks return before stdin processing, do not enforce, send, or queue
events; they still write the provider's payload-less passive response, because a
provider whose protocol expects a decision would otherwise stall. `otel-headers`
returns no authorization header. Configuration and queued data are retained.
Managed native exporter settings are removed using the same ownership and backup
mechanisms as uninstall. Failures are reported, with the marker retained, and
running `agentwatch off` again re-runs the removal for the recorded providers. **Restart/close existing agents:** static headers, exporters,
and pending native batches may remain in memory until then. Off cannot recall
requests already in flight or control independently configured exporters.

`agentwatch on` restores previously suspended managed exporters and removes the
marker only on success. It does not add hooks or undo an intervening uninstall.
Foreign exporter conflicts require repair and a retry. `uninstall` removes owned
hooks/settings and keeps local state; `uninstall --purge` also removes AgentWatch
configuration and data, including queued records and backups. Unrelated user
hooks/settings are preserved. AgentWatch does not remove the globally installed
npm package itself.

Codex and Gemini static token storage is a current limitation, not an encrypted
credential-store integration. Cursor has no native usage exporter/readable usage;
its CLI currently exposes only shell hooks, while IDE hooks cover more lifecycle
events. Antigravity has neither native token telemetry nor readable transcript
usage. Their summaries can remain `pending` without cost; no usage is fabricated.

A local administrator—and ordinarily the owning user—can remove or modify hooks,
configuration, credentials, and the off marker. Every line of code that runs on
the machine is in this MIT-licensed repository; the closed half is the backend
that receives the records. No signing, notarization, penetration-test completion,
or SOC 2 attestation is claimed. MDM templates and a per-agent statement of what
an administrator can and cannot lock are in
[examples/mdm](https://github.com/agent-watch-ai/agent-watch-edge/tree/main/examples/mdm); Claude Code is currently the only
agent with a managed policy file, and Codex requires one manual per-machine
approval (`/hooks`) that no script can perform.
See [deferred enterprise work](ENTERPRISE_DEPLOYMENT.md).
