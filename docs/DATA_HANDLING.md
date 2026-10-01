# Data handling contract

This document describes `0.3.0`, not every previously published package. **Every
release up to and including npm `0.2.5` enabled content capture by default**;
`0.3.0` is the release that turns it off and puts it behind explicit consent.
Check the installed version — `agentwatch --version` — and run `agentwatch config`
and `agentwatch doctor` during deployment. To check this document against the source
with your own coding agent, use [AUDIT_PROMPT.md](AUDIT_PROMPT.md).
AgentWatch is a user-level, hook-only Node.js program. It does not install a daemon,
require root, proxy model requests, or enforce an administrator-proof policy.

## Defaults and upgrade consent

**Prompt text and tool content are opt-in; response text is never collected.**
By default a prompt or response is represented only by its length and SHA-256.
There is no capture flag for response text.

Prompt text, tool input and tool output bodies are not collected by default.
Default capture is:

```json
{
  "contentCaptureConsent": false,
  "capture": {
    "promptText": false,
    "toolInput": false,
    "toolOutput": false,
    "git": true,
    "files": true
  }
}
```

To find which checkout a turn worked in, the hook inspects a shell command's text
in memory for directory names and discards it. This applies to the shell calls of
every agent the edge supports: Claude Code, Codex, Cursor, Gemini CLI and
Antigravity. The command's working directory is used as a candidate when the agent
reports it (Cursor's shell `cwd`, Gemini's `dir_path`, Antigravity's `Cwd`), and so
are the folders a Cursor window has open. Only checkout roots confirmed on disk
are kept, in local turn state, until the turn closes. The command is never stored,
queued, logged or sent for that purpose. This happens only while `capture.git` is
on. Separately, with `toolInput` on, the command text itself is sent on the turn
summary (see `tool_inputs` below).

Configurations written by earlier releases may still carry `capture.prompts` or
`capture.responses`. Those keys are ignored on load whatever their value —
`prompts: true` does not turn on `promptText`, a new name chosen for that reason — the next
`agentwatch setup` removes them from the file and says so once, and `doctor`
reports them while they remain.

Old configurations with content flags explicitly `true` are interpreted as
metadata-only unless the global `contentCaptureConsent` marker is exactly `true`.
Neither loading nor `agentwatch setup` rewrites those flags: the gate is applied in
memory on every read, so adding the marker later restores the values already on
disk rather than finding them erased. Missing, unreadable, invalid, and corrupt
global configuration do not authorize content capture. Git and file-path capture
remain enabled unless separately disabled.

Intentional content opt-in requires editing the **global**
`~/.agentwatch/config.json`: set `contentCaptureConsent` to `true` and explicitly
set `promptText`, `toolInput` and/or `toolOutput` to `true`. The marker alone does not enable
fields that are false. Set the marker to `false` to revoke consent. `config`,
`status`, and `doctor` report consent and capture state without printing captured
content. Repository `.agentwatch.json` files cannot grant consent, increase any
capture field, alter identity, redirect delivery, or change
enforcement/delivery/native OTel settings. They may reduce individual capture
fields.

Current policy is reapplied to old turn state before queueing, and to every queued
record before HTTP delivery: summaries always lose `prompt` and `response` text an
older release may have written, lose `prompt_text` and `tool_inputs` unless their
flag is on with consent, lose every path list once `capture.files` is off, and repository snapshots are dropped entirely once
`capture.git` is off. Old files are not erased by an upgrade; their original content
may remain locally until consumed or expired, but it is never sent.

**Upgrade native telemetry separately:** rerun `agentwatch setup` after upgrading,
then restart every running coding agent. Existing native exporter configuration
and in-memory exporters do not change merely because npm replaces the CLI.
Use `agentwatch off` and close agents before upgrading if export must be stopped
during the transition. Setup always disables native prompt logging (Claude
`OTEL_LOG_USER_PROMPTS=0`, Codex `log_user_prompt = false`, Gemini
`GEMINI_TELEMETRY_LOG_PROMPTS=false`) and Claude tool detail/content logging,
whatever the consent state, and never enables Gemini detailed traces, which can
carry prompts. Codex and Gemini usage logs can contain tool arguments/results
without a reliable per-field filter, so the Edge configures those logs only when
global consent exists and both `toolInput` and `toolOutput` are enabled. Gemini
metrics may run without content consent. This can leave `llm.call` usage
unavailable by default for Codex and Gemini.

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
`developer_id`, `repository`, `branch`, `commit`, `jira_ids`, `work_evidence`,
`files_changed`, `files_touched`, `files_read`, `external_files_touched`,
`external_files_read`, `prompt_evidence`, `prompt_text`, `tool_inputs`, `response_evidence`,
`tool_calls`, `tools_used`, `model`, `billing_mode`, `input_tokens`,
`cached_input_tokens`, `cache_creation_input_tokens`, `output_tokens`,
`usage_status`, `started_at`, and `ended_at`. The nested `session` contains `id`,
`providerId`, and optionally `turnId`.

No field carries response text. Evidence contains `length` and `sha256` of the
text the developer typed and the agent answered; it is not raw text, but hashes
and lengths can still reveal information about short or guessable text. The
prompt evidence hashes the prompt as the agent reported it.

- `prompt_text` (only under `promptText` with consent): the turn's first prompt,
  with `<system-reminder>` blocks the agent's harness injected removed, secrets
  scrubbed over the whole text, then cut at 4,000 characters.
- `tool_inputs` (only under `toolInput` with consent): per shell or connector (MCP)
  call, `{tool, command}` or `{tool, server, name, arguments}` with the arguments as
  JSON text; sensitive argument keys are redacted before that, every string is cut
  at 2,000 characters after scrubbing, and at most 50 calls are sent per turn.
  Tool output bodies are not sent on the summary; enabling tool flags does not add
  a tool event stream.
- `external_files_touched` / `external_files_read` (under `files`, and only while
  `git` is on, since that is what tells inside a checkout from outside): files outside
  every checkout, home-relative (`~/Documents/a.xlsx`); a path outside the home
  directory is sent as it is. `files_touched` and `files_read` are unchanged:
  repo-relative, or a bare basename for a file in no checkout, as before.

Between the prompt hook and the turn's close, the scrubbed prompt text and tool
inputs sit in local turn state (mode 0600), and only while their flag is on; the
close consumes them, and a session's end or the 24-hour expiry deletes the rest.

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

Two request headers are added to the managed native exporters, and nothing else
on that route is ours: `Authorization`, carrying the ingest token, and
`x-agentwatch-installation`, carrying this installation's id. That id is a random
UUID generated locally on first use; it is not derived from a user, a machine
name or any account, and it identifies nothing without the backend that issued
the token. It is what lets measured per-call usage be traced back to a sender
when the turn summary that would have named a developer never arrives. Claude
Code receives both through its `otelHeadersHelper`, so neither is written to its
settings file; Codex and Gemini receive them in the config files described under
"Identity, local storage, and credentials". No developer identity is placed in a
native exporter header or resource attribute.

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
can remain absolute, with the home prefix abbreviated to `~`.

Each turn reports the checkout its work changed, wherever the session started.
Agents often sit in one folder and work in a worktree beside it through shell
commands. A tool hook names candidate checkouts — the one it runs in, a file
tool's file's, those a shell command names or runs in, and Cursor's open
workspace folders — and records each candidate's
root with a fingerprint of it (HEAD, branch, and the dirty paths' status letters,
sizes and modification times). The turn's closing hook fingerprints them again and
reports, in order: the checkout the turn changed most; else the session's last
changed checkout; else the one it named most; else the folder it ended in, as
before. `work_evidence` says which of the four (`changed`, `carried`,
`referenced`, `cwd`). `files_changed` lists only the files this turn changed
there (at most 500), no longer the checkout's whole dirty tree, and
`files_touched` / `files_read` carry that checkout's paths only; paths in other
checkouts are dropped, while the calls still count. No new class of data is
collected: repository, branch, commit and paths were already sent for a session
started inside a repository.

Which checkouts may be reported is decided by the folder the session started in.
With project roots configured, only checkouts that the start folder's root
claims; without them, only checkouts beneath the start folder. A checkout
another root claims is refused outright: it gets no record and is never
fingerprinted. Checkouts are judged by where they really are, not through symlinks.
Local turn state keeps the candidate roots, the fingerprints, the start folder
and the session's last changed checkout's root (`work-checkout.json`); none of it
is sent, and it goes with the session's other turn state. The prompt gate reads
that file to ask about that checkout's repository and branch instead of the
folder the agent sits in; the same two fields travel as before, and never for a
checkout the asking folder's root does not govern.

What is reported about that repository follows *its* effective config, not the
start folder's: a `.agentwatch.json` committed inside it narrows the turn exactly
as it would a session started there — `capture.git: false` withholds the
repository, branch, commit and ticket keys, `capture.files: false` its paths.
And a repository that a project root of its own claims (see README, "Two
tenants on one machine") is never a candidate: the start folder alone decides which tenant a
session sends as, so that repository's name, branch, commit and paths are
dropped rather than delivered to another tenant.

This resolution reads the file paths the agent's tools named, so it follows
`capture.files`: with `capture.files: false` no path is captured, and a session
started above its repositories then reports no repository or branch — as it did
before. A session started inside a repository is unaffected, since its
repository comes from the start folder rather than from any path.

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
cleanup bound, and queued records a `maxEventAgeDays` bound (7 by default). Both
sweeps are activity-driven and run at most hourly. On an active installation,
removal happens at the next eligible sweep after expiration; an idle machine
retains the files until activity resumes. Backups and other local caches have no
guaranteed automatic deletion deadline. The package does not delete provider-owned
transcripts; it can read them locally for usage attribution.

Config, queues, turn state and the off marker use POSIX mode 0600.

**Codex and Gemini hold a static bearer token in their own configuration file,
and this is a property of those agents rather than a choice made here.** Neither
CLI has a mechanism for fetching a credential at request time, so the only way
to authenticate their native OTLP exporters is to write the bearer into the file
they read at startup: `~/.codex/config.toml` for Codex, and
`OTEL_EXPORTER_OTLP_HEADERS` inside `~/.gemini/settings.json` for Gemini. Claude
Code does have such a mechanism — `otelHeadersHelper`, which calls
`agentwatch otel-headers` at runtime — so no Claude configuration file ever
contains a token. Cursor and Antigravity have no managed native exporter, so the
question does not arise for them.

Because those two files then contain a credential, AgentWatch sets them to 0600
when — and only when — the block it writes actually carries the token. The files
belong to those agents, not to AgentWatch, so the permission bits each one had
beforehand are recorded in the install state and restored by `uninstall`: a file
that was 0644 before does not stay 0600 after the token is gone. A file that was
already private stays private, and nothing is tightened when no credential is
written. Backups preserve source permissions and can contain
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
when configured. Every URL in the configuration is validated on every *read* of
the file, not only when `setup` writes it: `https://` anywhere, and `http://`
only to `localhost`, `127.0.0.1` or `::1`. A configuration naming any other
scheme — or plain `http://` to a remote host — refuses that URL and `doctor`
reports it. The remaining valid configuration and identity stay loaded; a
refused root destination does not inherit machine telemetry routes.
Enforcement sends developer and checkout attribution, and the session's
model when the agent named one, not prompt/tool bodies.
Doctor probes connectivity with an empty events batch carrying the same
credentials a real delivery uses, so its verdict describes the configured
install: it distinguishes a backend that accepted the credential, one that
rejected it (a failure, with a non-zero exit code), one that is unreachable, and
an install with no backend configured yet. It always performs that probe, even
while sends are suspended — the diagnostic is a direct question to the backend
and is never answered from local state. Status can drain the queue. Both stop
network activity while disabled.

Hook errors return the provider's passive response/exit zero. Unknown inputs,
missing configuration, parser failures and unexpected exceptions must not crash
the coding agent. A delivery pass shares a default 1,500 ms monotonic network budget across
its direct send, backlog batch and isolation probes. Each request uses the
remaining budget. Exhaustion defers unsent records without consuming their retry
attempts or marking the backend unavailable. Filesystem work, transcript settling,
enforcement and snapshots have separate costs; this is not a hard deadline for
the entire hook. Failed records are queued before diagnostic writes, with bounded
retries and eventual loss reported by status.

The gateway reports partial publish failures as HTTP 503, so the entire batch
is retried with its original IDs. A 2xx acknowledges the batch; its `rejected`
counter records permanent per-event rejection without a retry or cooldown.
Receivers must handle replay safely: the gateway's dedupe cache lasts 10 minutes,
while edge backoff can reach 6 hours. Later retries require durable idempotency
in downstream storage; the gateway cache alone is insufficient. A thrown transport
error also queues the records. Unread response bodies are cancelled and stream
readers are released.

A backend that answers 401 or 403 is refusing the credential, not failing
transiently. The records stay queued — a product record is never discarded on a
failed send, and that does not change — but automatic sends for that
(destination, credential) pair are suspended rather than re-presenting a
rejected bearer on every hook for the whole retention window, which reads to a
backend's security monitoring as low-rate credential stuffing and to the
operator as nothing at all. No queued entry spends a retry attempt while the
refusal stands, including when it first occurs during an isolation probe.
Normal age and size retention limits still apply. `status` reports the refusing status, when the refusals started and how
many records are held. The suspension is lifted by configuring a different
credential or endpoint, or by `doctor` proving the credential good again; it
never expires on a timer. This is
not a guarantee of lossless delivery. Native exporter retry behavior is owned by
the provider, not the Edge queue. Sanitization is unconditional for Edge records;
it redacts known credential patterns/sensitive keys and bounds string/depth sizes.
Pattern matching cannot guarantee discovery of every possible secret.

Enforcement is fail-open on unexpected errors, timeouts, invalid responses and
unreachable services. A refused root base has no usable decision route; doctor
reports that budget caps are not enforced, with a failure and a repair instruction.
It does not send that root's bearer to machine enforcement as a fallback. A supported hook blocks only on an explicit backend block
decision. Defaults are a 300 ms request timeout and 60-second local decision
cache. Antigravity has no verified blocking response. This is not a local signed
enforcement policy or tamper-resistant control.

The request may also carry the model the session is on, so a budget can be set
on one model. Codex, Cursor, Gemini and Antigravity all name their
model on every hook they send, so for those the payload the gate already holds
names it. Claude Code names it only when a session starts, so
that one event writes it to `session.json` in that session's own `turns/`
directory (mode 0600, beside that session's turn records) to be read back at the
gate.
That file lives as long as the session does: it is deleted with the session's
state at SessionEnd, and by the 24-hour sweep for a session that crashed without
one. The model is stated exactly as reported usage spells it, and it is part of
the local decision cache key — an answer about one model is never reused for a
prompt on another. A collector that never learned a model states none and is
answered as it is today.

**The gate makes a network request.** Before a turn starts, the pre-prompt hook
reads a local decision cache and, on a miss, asks the platform — one bounded
request, 300 ms ceiling, every failure allowing the turn. Stating the model adds
one read of a small local file to that, and nothing else: no subprocess, no
second request, and a file that cannot be read means no model is stated rather
than a gate that waits. Two consequences are worth stating rather than leaving
to be discovered. A platform outage does not stop developers; it un-enforces
every budget for as long as it lasts, which at the default cache TTL means
decisions go unmade for up to a minute past recovery. And the cache is not
always a saving: an organization with a feature-scoped policy receives
`cache_ttl_ms: 0` on every answer, because a
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
credential-store integration; see *Identity, local storage, and credentials*
above for why those two agents differ from Claude Code, and for what `uninstall`
restores. Cursor has no native usage exporter/readable usage;
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
