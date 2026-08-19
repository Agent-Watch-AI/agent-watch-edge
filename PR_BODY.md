Title: Delivery correctness: rejected-event visibility, fair queue, truthful evidence, private backups

## Summary

Four delivery-correctness fixes (plan: `docs/superpowers/plans/2026-08-15-delivery-correctness.md`):

- **Rejected events are no longer invisible**: the transport parses the gateway's per-event counters from the 202 body, a persisted `delivery-stats.json` tally (lock-serialized with a bounded 300 ms wait) accumulates them, and `agentwatch status` warns when data was permanently rejected.
- **Queue fairness**: eviction, oldest-age reporting and drain order now follow the entry's own `firstQueuedAt` instead of file mtime — a retrying poison entry can no longer outlive never-attempted events, and drains are oldest-first instead of hash-ordered.
- **Truthful content evidence**: `prompt_evidence`/`response_evidence` are recomputed from the sanitized, truncated text actually transmitted (capture-time evidence is kept when the text is not sent), so a backend verifying length/hash can trust honest events.
- **Private backups**: `backupFile` explicitly preserves the source file's mode, so a backup of a credential-bearing config is never more readable than its source.

## Testing

280 vitest tests green (8 new across delivery-stats, queue fairness, evidence alignment, backup mode — written red-first), `tsc --noEmit` and eslint clean. Lock-contention behavior covered by tests that hold and release the lock file for real.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
