# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub Security Advisories on this repository
(Security → "Report a vulnerability"). Do not open public issues for security reports. You can
expect an acknowledgement within a few business days.

## Scope & design guarantees

AgentWatch Bridge handles developer activity metadata, so the following are treated as security
bugs of the highest priority:

- prompt/response/tool content leaving the machine while capture flags are off
- secrets (tokens, keys, credentials, URL-embedded credentials) surviving the sanitizer in
  events, logs, queue files, or diagnostics output
- credentials written into agent config files (the backend token belongs only in
  `~/.agentwatch/config.json`, mode 0600, or delivered via `otelHeadersHelper`)
- destructive or non-mergeful writes to `~/.claude` / `~/.codex` configuration
- the hook process breaking or blocking the host coding agent

## Data handling summary

- Default telemetry is metadata-only; content capture is opt-in per category.
- Git remote URLs are credential-stripped and hashed before transmission.
- Local queue files live under the user's data directory and contain already-sanitized events.
- `doctor`/`status` never print token values.
