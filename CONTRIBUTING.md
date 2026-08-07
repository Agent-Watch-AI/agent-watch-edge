# Contributing to AgentWatch Bridge

Thanks for helping! The project is TypeScript (ESM, Node >= 20), tested with Vitest.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

All four must pass before a PR. Tests run against temporary HOME directories and must never read
or modify your real `~/.claude` / `~/.codex` configuration — keep it that way.

## Adding a new agent provider

1. Create `src/providers/<id>/` with detect / hooks / adapter / otel modules implementing the
   `AgentProvider` interface from `src/providers/provider.ts`.
2. Translate native event names into canonical types (`src/events/canonical-event.ts`); never
   leak provider naming into core modules.
3. Verify the agent's **current official** hook and telemetry documentation — do not copy
   assumptions from other providers. Note doc/source references in code comments with a date.
4. Config mutation rules (non-negotiable):
   - merge, never overwrite; refuse to touch unparseable files
   - idempotent installs; uninstall removes only AgentWatch-owned entries
   - atomic writes + timestamped backups (`src/storage/atomic-file.ts`)
5. Add realistic payload fixtures under `tests/fixtures/` and cover: detection, install/uninstall
   (preservation + idempotency), event parsing (including malformed payloads), and privacy
   defaults.
6. Register the provider in `src/providers/registry.ts`.

## Ground rules

- The hook path runs inside coding agents' critical path: keep startup lean, avoid new
  dependencies, keep network timeouts short, and never write diagnostics to stdout.
- Privacy first: new fields must default to metadata-only; content capture is opt-in and must
  pass through the sanitizer.
- No daemons, proxies, or network interception.
