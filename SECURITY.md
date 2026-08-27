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
  in `~/.agentwatch/config.json` (0600).
- destructive or non-mergeful writes to `~/.claude` / `~/.codex` configuration
- the hook process breaking or blocking the host coding agent

## Data handling summary

- The public contract contains only `llm.call` and `turn.summary`. Raw lifecycle/tool hooks stay
  local; tool I/O is never a third outbound event stream. If config is missing or corrupt, the
  runtime fails safe to metadata-only summary capture.
- Git remote URLs are credential-stripped and hashed before transmission.
- Local queue files live under the user's data directory and contain already-sanitized events.
- `doctor`/`status` never print token values.
