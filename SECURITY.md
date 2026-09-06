# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub Security Advisories on this repository
(Security → "Report a vulnerability"). Do not open public issues for security reports. You can
expect an acknowledgement within a few business days.

## Scope & design guarantees

AgentWatch Edge handles developer activity metadata, so the following are treated as security
bugs of the highest priority:

- prompt/response/tool content leaving the machine while capture flags are off
- secrets (tokens, keys, credentials, URL-embedded credentials) surviving the sanitizer in
  events, logs, queue files, or diagnostics output
- credentials written into agent config files beyond the two sanctioned places: Claude Code
  gets the token via `otelHeadersHelper` (never written to its settings), while Codex has no
  headers-helper mechanism, so its OTel exporter carries the Bearer token inside
  `~/.codex/config.toml` — which setup therefore keeps at mode 0600. The primary copy lives
  in `~/.agentwatch/config.json` (0600). Gemini also stores static OTLP bearer
  headers in `~/.gemini/settings.json` (0600); it has no headers helper.
- destructive or non-mergeful writes to `~/.claude` / `~/.codex` configuration
- the hook process breaking or blocking the host coding agent

## Every line that runs on the developer's machine is open

There is no closed on-device component. What the Edge does on a laptop — which
hooks it registers, what it reads, what it sends, what the sanitizer strips — is
this repository, MIT-licensed, and a reviewer can read it rather than take our
word for it. The closed half is the backend that receives the records.

That is also the honest limit: a local administrator can read, edit or remove
any of it. The Edge does not self-protect and does not re-apply itself on a
schedule; a machine that stops reporting is the signal, and it is visible on the
platform side. See [MDM deployment](https://github.com/agent-watch-ai/agent-watch-edge/tree/main/examples/mdm) for what an
administrator can and cannot lock per agent.

## Data handling summary

- The public contract contains `llm.call`, `turn.summary`, and `repo.snapshot`. Raw lifecycle/tool hooks stay
  local; tool I/O is never a third outbound event stream. If config is missing or corrupt, the
  runtime fails safe to metadata-only summary capture.
- Git remote URLs are credential-stripped and normalized; hashes are available,
  but summaries and snapshots also disclose normalized repository names.
- Local queue files live under the user's data directory and contain already-sanitized events.
- `doctor`/`status` never print token values.

The [data handling contract](docs/DATA_HANDLING.md) specifies collection defaults,
global consent migration, native OTLP boundaries, credentials, retention and the
local off switch. Native exporters require setup and an agent restart after an
upgrade; the hook consent gate cannot filter traffic sent directly by an agent.
No compliance attestation or completed penetration test is claimed. See
[deferred enterprise work](docs/ENTERPRISE_DEPLOYMENT.md).
