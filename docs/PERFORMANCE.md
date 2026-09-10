# Performance verification

Run `npm run benchmark` after installing dependencies. It builds the package,
starts a fresh CLI process for each hook sample, and measures real filesystem
queue scans with batches of 25. Everything lives in a temporary directory which
is removed afterwards. No actual agent configuration or external backend is used.
Set `AGENTWATCH_BENCH_SAMPLES` to an integer from 5 to 1000 (default 30).

The hook scenario is a small Claude `PostToolUse` payload with content capture,
git capture and enforcement off, and no backend. It measures Node startup,
configuration loading and local processing. It does not measure a Stop hook's
transcript settling, repository enrichment, snapshots or network latency.

Queue scenarios contain 0, 100 or 2,000 records in backoff. The initial full
retention sweep is timed separately, then the bounded rotating scans are measured.
This distinction matters: the hourly sweep still reads the partition and can cost
more than an ordinary pass. A batch-size bound is not constant total filesystem
cost: directory listing and sorting still depend on backlog size.

Example local run, September 10, 2026: Apple M3 Pro, macOS arm64, Node v24.13.1,
30 samples, warm filesystem, interactive machine. Values in milliseconds:

| Scenario | p50 | p95 | Maximum | Initial full sweep |
| --- | ---: | ---: | ---: | ---: |
| Fresh CLI, small PostToolUse, no backend | 53.34 | 58.07 | 58.84 | — |
| Empty queue | 0.24 | 0.38 | 1.05 | 2.46 |
| 100 queued records | 5.14 | 6.16 | 6.20 | 9.64 |
| 2,000 queued records | 6.99 | 8.04 | 13.80 | 124.11 |

These are observations, not an SLA or a cross-machine comparison. At 30 samples,
p99 is effectively the maximum. CI retains its own JSON measurements on Linux
and macOS rather than enforcing unstable absolute timing thresholds on shared
runners.

`delivery.timeoutMs` is a shared monotonic network deadline for one delivery
pass: a request gets only the remaining time, and later sends are deferred when
it is exhausted. Deferral keeps queued records and their retry counters intact.
This is not an end-to-end hook deadline: startup, filesystem work, transcript
settling, enforcement and snapshots have additional costs. Tests exercise
partial acceptance, exhausted budgets and authentication failures independently
of machine speed.
