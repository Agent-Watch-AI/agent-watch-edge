# Changelog

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
