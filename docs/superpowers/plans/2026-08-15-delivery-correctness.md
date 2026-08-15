# Bridge Delivery Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bridge's delivery path honest and fair: surface backend-rejected events instead of losing them silently, evict/drain the offline queue by real age instead of mtime, make transmitted content evidence hashes match the transmitted text, and keep backups of credential-bearing files as private as their sources.

**Architecture:** All changes live in `src/transport`, `src/turns`, and `src/storage`. No wire-format changes; one new optional field on `DeliveryResult` and one new persisted stats file (`delivery-stats.json` in the data dir, same pattern as `backend-cooldown.json`).

**Tech Stack:** TypeScript ESM (`.js` import suffixes), zod, vitest (`npm test` = `vitest run`). Tests live in `tests/*.test.ts` and import from `../src/...`.

**Branch:** create `fix/delivery-correctness` before the first commit.

---

### Task 1: Surface backend-rejected events

The gateway returns `202 {accepted, duplicate, rejected, failed}`; the bridge checks only `response.ok`, so per-event rejections are invisible and the data is gone. Fix: parse the counters, log them, persist a running tally, and show it in `agentwatch status`.

**Files:**
- Modify: `src/transport/transport.ts` (DeliveryResult)
- Modify: `src/transport/http-transport.ts` (parse counters)
- Create: `src/transport/delivery-stats.ts`
- Modify: `src/transport/delivery.ts` (record on direct send)
- Modify: `src/transport/queue.ts` (record on drain — new optional callback)
- Modify: `src/cli/hook.ts` (wire stats into deliverEvents)
- Modify: `src/cli/status.ts` (print the tally)
- Test: `tests/delivery-stats.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HttpTransport } from '../src/transport/http-transport.js';
import { deliverEvents } from '../src/transport/delivery.js';
import { DeliveryStats } from '../src/transport/delivery-stats.js';
import { EventQueue } from '../src/transport/queue.js';

function summary(id: string) {
  return {
    schemaVersion: '1',
    id,
    timestamp: '2026-08-15T10:00:00.000Z',
    event: { type: 'turn.summary', providerEventType: 'turn.summary' },
    agent: { provider: 'claude-code', name: 'claude-code' },
    session: { id: 'session-1' },
    provider: 'claude-code',
    surface: 'cli',
    tool_calls: 0,
    tools_used: {},
    usage_status: 'pending',
    ended_at: '2026-08-15T10:00:00.000Z'
  } as never;
}

function tempDirs() {
  const base = path.join(os.tmpdir(), `aw-stats-${Math.random().toString(36).slice(2)}`);
  return {
    queueDir: path.join(base, 'queue'),
    locksDir: path.join(base, 'locks'),
    statsFile: path.join(base, 'delivery-stats.json')
  };
}

describe('rejected-event accounting', () => {
  it('transport surfaces the response counters', async () => {
    const transport = new HttpTransport({
      eventsUrl: 'https://backend.example/v1/events',
      timeoutMs: 1000,
      fetchFn: async () =>
        new Response(JSON.stringify({ accepted: 1, duplicate: 0, rejected: 2, failed: 0 }), {
          status: 202,
          headers: { 'content-type': 'application/json' }
        })
    });

    const result = await transport.send([summary('evt_a')]);

    expect(result.ok).toBe(true);
    expect(result.counters).toEqual({ accepted: 1, duplicate: 0, rejected: 2, failed: 0 });
  });

  it('deliverEvents persists a running rejected tally', async () => {
    const dirs = tempDirs();
    const queue = new EventQueue({
      queueDir: dirs.queueDir,
      locksDir: dirs.locksDir,
      maxEvents: 100,
      maxAttempts: 5,
      maxEventAgeDays: 7
    });
    const transport = new HttpTransport({
      eventsUrl: 'https://backend.example/v1/events',
      timeoutMs: 1000,
      fetchFn: async () =>
        new Response(JSON.stringify({ accepted: 0, duplicate: 0, rejected: 1, failed: 0 }), {
          status: 202,
          headers: { 'content-type': 'application/json' }
        })
    });
    const stats = new DeliveryStats(dirs.statsFile);

    const outcome = await deliverEvents([summary('evt_b')], transport, queue, 25, undefined, stats);

    expect(outcome.rejected).toBe(1);
    const snapshot = await stats.read();
    expect(snapshot?.totalRejected).toBe(1);
    expect(snapshot?.lastRejectedCount).toBe(1);
    await fs.rm(path.dirname(dirs.queueDir), { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/delivery-stats.test.ts`
Expected: FAIL — `delivery-stats.js` does not exist; `result.counters` is undefined.

- [ ] **Step 3: Implement**

`src/transport/transport.ts` — extend `DeliveryResult`:

```ts
export interface DeliveryCounters {
  accepted: number;
  duplicate: number;
  rejected: number;
  failed: number;
}

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  /** Whether a failure is worth retrying later (network error, 5xx, 429...). */
  retryable: boolean;
  error?: string;
  /** Per-event outcome counters from an accepted batch, when the backend sent them. */
  counters?: DeliveryCounters;
}
```

`src/transport/http-transport.ts` — in `send`, replace the `response.ok` return with:

```ts
      if (response.ok) {
        return { ok: true, status: response.status, retryable: false, counters: await readCounters(response) };
      }
```

and add at module scope:

```ts
/**
 * A 202 can still carry per-event rejections; the batch "succeeding" while
 * events inside it were dropped is exactly the case the caller must see.
 * A backend that returns no JSON body is treated as counter-less, not failed.
 */
async function readCounters(response: Response): Promise<DeliveryResult['counters']> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const numeric = (key: string): number => (typeof body[key] === 'number' ? (body[key] as number) : 0);
    return {
      accepted: numeric('accepted'),
      duplicate: numeric('duplicate'),
      rejected: numeric('rejected'),
      failed: numeric('failed')
    };
  } catch {
    return undefined;
  }
}
```

`src/transport/delivery-stats.ts` (new):

```ts
import fs from 'node:fs/promises';
import { writeFileAtomic } from '../storage/atomic-file.js';

export interface DeliveryStatsSnapshot {
  totalRejected: number;
  lastRejectedCount: number;
  lastRejectedAt: string;
}

/**
 * Persisted tally of events the backend accepted the batch for but rejected
 * individually. Rejected events are never resent — the schema refused them —
 * so this file is the only local trace that data was discarded;
 * `agentwatch status` surfaces it.
 */
export class DeliveryStats {
  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  async read(): Promise<DeliveryStatsSnapshot | undefined> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<DeliveryStatsSnapshot>;
      if (typeof raw.totalRejected !== 'number') return undefined;
      return {
        totalRejected: raw.totalRejected,
        lastRejectedCount: typeof raw.lastRejectedCount === 'number' ? raw.lastRejectedCount : 0,
        lastRejectedAt: typeof raw.lastRejectedAt === 'string' ? raw.lastRejectedAt : ''
      };
    } catch {
      return undefined;
    }
  }

  async recordRejected(count: number): Promise<void> {
    if (count <= 0) return;
    try {
      const current = await this.read();
      const next: DeliveryStatsSnapshot = {
        totalRejected: (current?.totalRejected ?? 0) + count,
        lastRejectedCount: count,
        lastRejectedAt: this.now().toISOString()
      };
      await writeFileAtomic(this.file, JSON.stringify(next), 0o600);
    } catch {
      // Stats are diagnostics; failing to persist them must not break the hook.
    }
  }
}
```

`src/transport/delivery.ts`:
- Add `rejected: number` to `DeliveryOutcome` (set `rejected: 0` in every existing early return).
- Signature: `deliverEvents(events, transport, queue, drainBatchSize, cooldown?, stats?: DeliveryStats)`.
- After the successful direct send (before the drain), insert:

```ts
  const rejected = result.counters?.rejected ?? 0;
  if (rejected > 0) {
    debugLog(`backend permanently rejected ${rejected} event(s) from the direct send`);
    if (stats) await stats.recordRejected(rejected);
  }
```

- Pass a recorder into the drain calls: `queue.drain(transport, drainBatchSize, stats)` (both call sites) and include drain-path rejections in the returned `rejected`.

`src/transport/queue.ts`:
- `drain(transport, maxBatch, stats?: { recordRejected(count: number): Promise<void> })`.
- Add `rejected: number` to `DrainStats` (initialize 0).
- After the successful batch send (`result.ok`) and after each successful isolation probe, add:

```ts
      const rejected = result.counters?.rejected ?? 0;
      if (rejected > 0) {
        stats.rejected += rejected;
        debugLog(`backend permanently rejected ${rejected} queued event(s)`);
        if (statsRecorder) await statsRecorder.recordRejected(rejected);
      }
```

(name the parameter `statsRecorder` to avoid clashing with the local `stats` variable).

`src/cli/hook.ts` — where the cooldown is built:

```ts
  const stats = new DeliveryStats(path.join(context.paths.dataDir, 'delivery-stats.json'), options.env.now);
  const outcome = await deliverEvents(outbound, transport, queue, context.config.delivery.drainBatchSize, cooldown, stats);
  debugLog(`delivery: sent=${outcome.delivered} queued=${outcome.queued} drained=${outcome.drained} rejected=${outcome.rejected}`);
```

`src/cli/status.ts` — after the pending-events lines (~line 74), read the same file and warn when non-zero (adapt to the file's actual context/paths variables):

```ts
  const rejectedStats = await new DeliveryStats(path.join(context.paths.dataDir, 'delivery-stats.json')).read();
  if (rejectedStats && rejectedStats.totalRejected > 0) {
    println(`${symbols.warn} ${rejectedStats.totalRejected} event(s) permanently rejected by the backend (last ${rejectedStats.lastRejectedCount} at ${rejectedStats.lastRejectedAt})`);
  }
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, including existing transport/queue tests (update any that construct `DeliveryOutcome`/`DrainStats` literals).

- [ ] **Step 5: Commit**

```bash
git add src tests/delivery-stats.test.ts
git commit -m "feat(transport): surface and persist backend-rejected event counts"
```

---

### Task 2: Queue fairness — age is firstQueuedAt, not mtime

`enforceBound` evicts by mtime, but `recordFailure` rewrites entries, refreshing their mtime — so poison entries survive eviction while never-attempted valid events are dropped first. `oldestPendingAgeMs` under-reports for the same reason, and drain order is hash order.

**Files:**
- Modify: `src/transport/queue.ts` (`enforceBound`, `oldestPendingAgeMs`, `drain` ordering)
- Test: `tests/queue-fairness.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventQueue } from '../src/transport/queue.js';

function summary(id: string) {
  return {
    schemaVersion: '1',
    id,
    timestamp: '2026-08-15T10:00:00.000Z',
    event: { type: 'turn.summary', providerEventType: 'turn.summary' },
    agent: { provider: 'claude-code', name: 'claude-code' },
    session: { id: 'session-1' },
    provider: 'claude-code',
    surface: 'cli',
    tool_calls: 0,
    tools_used: {},
    usage_status: 'pending',
    ended_at: '2026-08-15T10:00:00.000Z'
  } as never;
}

function dirs() {
  const base = path.join(os.tmpdir(), `aw-queue-${Math.random().toString(36).slice(2)}`);
  return { base, queueDir: path.join(base, 'queue'), locksDir: path.join(base, 'locks') };
}

describe('queue fairness', () => {
  it('evicts by firstQueuedAt, not by file mtime', async () => {
    const { base, queueDir, locksDir } = dirs();
    let nowMs = Date.parse('2026-08-15T10:00:00Z');
    const queue = new EventQueue({
      queueDir,
      locksDir,
      maxEvents: 2,
      maxAttempts: 20,
      maxEventAgeDays: 7,
      now: () => new Date(nowMs)
    });

    await queue.enqueue([summary('evt_old')]);
    nowMs += 60_000;
    await queue.enqueue([summary('evt_mid')]);

    // A retry rewrites the oldest entry, refreshing its mtime.
    const failing = {
      async send() {
        return { ok: false, retryable: true, error: 'HTTP 500' } as const;
      },
      destination: undefined
    };
    await queue.drain(failing as never, 10);

    nowMs += 60_000;
    await queue.enqueue([summary('evt_new')]);

    const remaining = await fs.readdir(queueDir);
    // The bound is 2: the entry that has genuinely waited longest (evt_old)
    // is sacrificed, even though its retry made its file the newest on disk.
    expect(remaining.some((name) => name.includes('evt_old'))).toBe(false);
    expect(remaining.some((name) => name.includes('evt_mid'))).toBe(true);
    expect(remaining.some((name) => name.includes('evt_new'))).toBe(true);
    await fs.rm(base, { recursive: true, force: true });
  });

  it('reports the oldest pending age from firstQueuedAt', async () => {
    const { base, queueDir, locksDir } = dirs();
    let nowMs = Date.parse('2026-08-15T10:00:00Z');
    const queue = new EventQueue({
      queueDir,
      locksDir,
      maxEvents: 10,
      maxAttempts: 20,
      maxEventAgeDays: 7,
      now: () => new Date(nowMs)
    });

    await queue.enqueue([summary('evt_aged')]);
    nowMs += 3_600_000;

    expect(await queue.oldestPendingAgeMs()).toBe(3_600_000);
    await fs.rm(base, { recursive: true, force: true });
  });

  it('drains oldest-first by firstQueuedAt', async () => {
    const { base, queueDir, locksDir } = dirs();
    let nowMs = Date.parse('2026-08-15T10:00:00Z');
    const queue = new EventQueue({
      queueDir,
      locksDir,
      maxEvents: 10,
      maxAttempts: 20,
      maxEventAgeDays: 7,
      now: () => new Date(nowMs)
    });

    // Enqueue in an order whose hash order differs from age order.
    await queue.enqueue([summary('evt_zzz_first')]);
    nowMs += 1000;
    await queue.enqueue([summary('evt_aaa_second')]);

    const sent: string[][] = [];
    const transport = {
      async send(events: { id: string }[]) {
        sent.push(events.map((event) => event.id));
        return { ok: true, retryable: false } as const;
      },
      destination: undefined
    };
    await queue.drain(transport as never, 1);

    expect(sent[0]).toEqual(['evt_zzz_first']);
    await fs.rm(base, { recursive: true, force: true });
  });
});
```

Note: the enqueued ids pass through `fileFor`'s sanitizer, so `evt_old` etc. are valid filenames. `summary()` events are product events (`turn.summary`), so `isProductEntry` keeps them.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/queue-fairness.test.ts`
Expected: the eviction test FAILS (evt_mid or evt_new evicted instead of evt_old, since evt_old's retry refreshed its mtime); the age test FAILS when mtime ≠ injected clock; the drain-order test FAILS (hash order sends evt_aaa_second first).

- [ ] **Step 3: Implement**

In `src/transport/queue.ts`:

1. **`enforceBound`** — sort by the entry's own `firstQueuedAt`, falling back to mtime only when the entry cannot be read:

```ts
  /** Keep the queue bounded: entries that have waited longest are sacrificed first. */
  private async enforceBound(): Promise<void> {
    const files = await this.listFiles();
    const excess = files.length - this.options.maxEvents;
    if (excess <= 0) return;
    const withAge = await Promise.all(
      files.map(async (name) => {
        const full = path.join(this.options.queueDir, name);
        const entry = await this.readEntry(full);
        if (entry) return { full, queuedAt: Date.parse(entry.firstQueuedAt) };
        try {
          // Unreadable entry: fall back to the file clock so it still ages out.
          const stat = await fs.stat(full);
          return { full, queuedAt: stat.mtimeMs };
        } catch {
          return undefined;
        }
      })
    );
    const sorted = withAge
      .filter((file): file is { full: string; queuedAt: number } => Boolean(file))
      .sort((a, b) => a.queuedAt - b.queuedAt);
    for (const { full } of sorted.slice(0, excess)) {
      await fs.rm(full, { force: true });
    }
  }
```

2. **`oldestPendingAgeMs`** — same source of truth:

```ts
  async oldestPendingAgeMs(): Promise<number | undefined> {
    const files = await this.listFiles();
    if (files.length === 0) return undefined;
    let oldest: number | undefined;
    for (const file of files) {
      const entry = await this.readEntry(path.join(this.options.queueDir, file));
      if (!entry) continue;
      const queuedAt = Date.parse(entry.firstQueuedAt);
      if (Number.isFinite(queuedAt) && (oldest === undefined || queuedAt < oldest)) oldest = queuedAt;
    }
    return oldest === undefined ? undefined : this.now().getTime() - oldest;
  }
```

3. **`drain`** — collect every due entry first, then take the oldest `maxBatch`. Replace the `for (const name of await this.listFiles())` loop: remove the `if (due.length >= maxBatch) break;` line, keep all the drop/skip logic, and after the loop add:

```ts
      // Oldest first: hash-ordered filenames would otherwise let a large
      // backlog defer the same late-sorting entries on every drain.
      due.sort((a, b) => Date.parse(a.entry.firstQueuedAt) - Date.parse(b.entry.firstQueuedAt));
      const batch = due.slice(0, maxBatch);
      if (batch.length === 0) return stats;
```

and use `batch` instead of `due` everywhere below (send, delete, isolation loop).

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, including `queue.test.ts` and `offline-queue.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/transport/queue.ts tests/queue-fairness.test.ts
git commit -m "fix(queue): age, eviction and drain order follow firstQueuedAt instead of mtime"
```

---

### Task 3: Content evidence describes the transmitted text

`prompt_evidence`/`response_evidence` are hashed at capture time, but the sanitizer later truncates (8192 chars) and redacts the text — so the transmitted hash disagrees with the transmitted content. Fix: after sanitizing the summary, recompute evidence from the final text whenever the text is present.

**Files:**
- Modify: `src/turns/turn-summary.ts` (add `alignContentEvidence`)
- Modify: `src/turns/turn-tracker.ts:111,202` (both `sanitizeValue(summary)` sites)
- Test: `tests/evidence-alignment.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { alignContentEvidence } from '../src/turns/turn-summary.js';
import { sanitizeValue } from '../src/privacy/sanitizer.js';
import { sha256Hex } from '../src/events/event-id.js';

describe('content evidence alignment', () => {
  it('recomputes evidence from the sanitized, truncated text', () => {
    const longPrompt = `token=super-secret-value ${'x'.repeat(9000)}`;
    const summary = {
      prompt: longPrompt,
      prompt_evidence: { length: longPrompt.length, sha256: sha256Hex(longPrompt) },
      response: 'short answer',
      response_evidence: { length: 12, sha256: sha256Hex('short answer') }
    } as never;

    const sanitized = sanitizeValue(summary) as { prompt: string; response: string };
    const aligned = alignContentEvidence(sanitized as never) as unknown as {
      prompt: string;
      prompt_evidence: { length: number; sha256: string };
      response: string;
      response_evidence: { length: number; sha256: string };
    };

    expect(aligned.prompt.length).toBeLessThanOrEqual(8192);
    expect(aligned.prompt_evidence.length).toBe(aligned.prompt.length);
    expect(aligned.prompt_evidence.sha256).toBe(sha256Hex(aligned.prompt));
    expect(aligned.response_evidence.sha256).toBe(sha256Hex(aligned.response));
  });

  it('keeps capture-time evidence when the text is not transmitted', () => {
    const original = { length: 999, sha256: 'abc' };
    const summary = { prompt_evidence: original } as never;

    const aligned = alignContentEvidence(summary) as unknown as {
      prompt_evidence: { length: number; sha256: string };
    };

    expect(aligned.prompt_evidence).toEqual(original);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/evidence-alignment.test.ts`
Expected: FAIL — `alignContentEvidence` is not exported.

- [ ] **Step 3: Implement**

`src/turns/turn-summary.ts` — add the import and export:

```ts
import { contentEvidence } from '../providers/shared/tooling.js';
```

```ts
/**
 * Recompute content evidence from the text that is actually transmitted.
 *
 * Evidence is captured before sanitization, but the sanitizer truncates and
 * redacts; a backend verifying length or hash against the received text would
 * then reject honest events. When the text is absent (capture disabled), the
 * capture-time evidence still describes the content the developer saw, and is
 * kept as the only description there is.
 */
export function alignContentEvidence(summary: TurnSummaryEvent): TurnSummaryEvent {
  const aligned = { ...summary };
  if (typeof aligned.prompt === 'string') aligned.prompt_evidence = contentEvidence(aligned.prompt);
  if (typeof aligned.response === 'string') aligned.response_evidence = contentEvidence(aligned.response);
  return aligned;
}
```

`src/turns/turn-tracker.ts` — both return sites become:

```ts
    return alignContentEvidence(sanitizeValue(summary));
```

(add `alignContentEvidence` to the existing `./turn-summary.js` import).

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS (check `turns.test.ts` — if it asserted the old capture-time hashes on transmitted text, update it to the aligned expectation).

- [ ] **Step 5: Commit**

```bash
git add src/turns tests/evidence-alignment.test.ts
git commit -m "fix(turns): content evidence matches the sanitized text actually transmitted"
```

---

### Task 4: Backups keep the source file's permissions

`backupFile` copies credential-bearing files (`~/.codex/config.toml` holds the raw bearer token) into `backups/` with `fs.copyFile`. Make the mode explicit so a backup is never more readable than its source, regardless of platform copy semantics.

**Files:**
- Modify: `src/storage/atomic-file.ts:41-52`
- Test: `tests/backup-mode.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backupFile } from '../src/storage/atomic-file.js';

describe('backupFile', () => {
  it('preserves the source file mode on the backup', async () => {
    const base = path.join(os.tmpdir(), `aw-backup-${Math.random().toString(36).slice(2)}`);
    const source = path.join(base, 'config.toml');
    const backups = path.join(base, 'backups');
    await fs.mkdir(base, { recursive: true });
    await fs.writeFile(source, 'Authorization = "Bearer secret"', { mode: 0o600 });

    const target = await backupFile(source, backups, new Date('2026-08-15T10:00:00Z'));

    expect(target).toBeDefined();
    const mode = (await fs.stat(target as string)).mode & 0o777;
    expect(mode).toBe(0o600);
    await fs.rm(base, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/backup-mode.test.ts`
Expected: likely FAIL on platforms where the copy landed with a broader mode; if it passes because the platform already preserves modes, the explicit chmod in Step 3 is still the correct hardening — implement it and keep the test as a regression guard.

- [ ] **Step 3: Implement**

Replace `backupFile` in `src/storage/atomic-file.ts`:

```ts
/** Copy the current file (if any) into backupsDir before we mutate it. */
export async function backupFile(filePath: string, backupsDir: string, now: Date): Promise<string | undefined> {
  let sourceMode: number;
  try {
    sourceMode = (await fs.stat(filePath)).mode & 0o777;
  } catch {
    return undefined;
  }
  await fs.mkdir(backupsDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupsDir, `${path.basename(filePath)}.${stamp}.bak`);
  await fs.copyFile(filePath, target);
  // A backup of a credential-bearing file must never be more readable than
  // the file it copies, whatever the platform's copy semantics.
  await fs.chmod(target, sourceMode);
  return target;
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage/atomic-file.ts tests/backup-mode.test.ts
git commit -m "fix(storage): backups keep the source file's permissions"
```

---

### Final verification

- [ ] Run: `npm run typecheck && npm run lint && npm test`
Expected: all PASS.

## Self-review checklist

1. Audit coverage: rejected-event visibility (T1), queue mtime unfairness + drain order + age metric (T2), evidence/hash mismatch after truncation-redaction (T3), credential backup mode (T4).
2. No wire-format changes: `counters` is read from the existing gateway response; nothing new is sent.
3. All new files use ESM `.js` import suffixes like the rest of `src/`.
