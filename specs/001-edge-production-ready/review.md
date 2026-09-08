# Enterprise readiness audit: `@agent-watch-ai/edge` v0.2.5

**Date**: 2026-09-08
**Question this audit answers**: would a large organization's security, platform
and code review — human or agent — let this package onto a fleet, and would it
find anything in it that looks careless?
**Scope**: all of `src/` (19,587 lines, 186 files), `tests/` (8,923 lines, 34
files), `AGENTS.md` / `STYLEGUIDE.md` conformance, packaging, CI, docs.
**Revision**: v3. Supersedes v1 (correctness, hot-path cost and dead weight
only) and v2, which was reviewed and found to contain a contradiction in the
401/403 semantics, an unsafe queue-filename proposal, an unsourced Windows
support claim, an unproven impact claim in SEC1, a factually wrong SBOM row and
unreproducible timings. Each is corrected below and listed in
[§11 Revision log](#11-revision-log). `spec.md` is derived from the v1 findings;
it must be re-derived from this document, and **FR-005 as written contradicts
[SEC3](#sec3--the-401403-decision-normative) and has to be rewritten first.**

## Baseline and measurement method

Environment: Apple M3 Pro, macOS 26.6.2, Node v24.13.1, warm filesystem cache,
interactive machine (not quiesced).

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | clean, 0 errors 0 warnings |
| `npm run build` | clean |
| `npm test` | 485/485 passing, 34 files, 12.6 s — **but not reproducible on every machine; see [T5](#t5--the-suite-is-not-reproducible-two-http-tests-can-outlive-the-timeout)** |
| redaction regex pass over an 8 KB adversarial string | 0–1 ms, no ReDoS |

Module-import cost, measured as **one fresh `node` process per sample, N = 15**,
`performance.now()` around a single dynamic `import()` of the built artifact:

| Imported module | median | p95 |
|---|---|---|
| `dist/cli/hook.js` (the whole hook path) | **33.3 ms** | 59.2 ms |
| `dist/providers/registry.js` (all five providers) | **22.9 ms** | 40.1 ms |
| `dist/providers/claude/claude.adapter.js` (one provider) | **10.3 ms** | 16.2 ms |
| `dist/pipeline/hook-pipeline.js` | 22.6 ms | 33.4 ms |
| `zod` | 11.6 ms | 13.2 ms |

Reproduce with:

```sh
npm run build
cat > /tmp/imp.mjs <<'EOF'
const t = performance.now();
await import(process.argv[2]);
process.stdout.write(String(performance.now() - t));
EOF
for i in $(seq 1 15); do node /tmp/imp.mjs "$PWD/dist/cli/hook.js"; echo; done \
  | sort -n | awk '{a[NR]=$1} END {printf "median=%.1f p95=%.1f\n", a[int(NR/2)+1], a[NR-1]}'
```

**These figures are not additive.** `registry.js`, `hook-pipeline.js` and `zod`
share dependencies (core, config, schemas), so each isolated measurement pays
for the shared graph itself. The only claim they support is a **bound**: making
provider loading lazy cannot save more than
`registry (22.9) − one adapter (10.3) ≈ 12 ms` of median import time, and the
real saving must be re-measured after the change rather than predicted from
this table.

**Process wall time is deliberately not quoted as a figure.** On this hardware a
bare `node` boot of an empty module alone measured median 44.7 ms / p95 97.8 ms
(N = 20), which is the same order as the entire hook; the variance swamps the
signal. Any wall-clock target for the hook needs a quiesced machine and a
stated harness, and this audit does not have one. What is defensible is the
*shape*: module loading dominates the hook's own work, and the registry
dominates module loading.

The package is in genuinely good shape, and that is the premise of this
document rather than its conclusion: no `else` anywhere, no `any`, no
`@ts-ignore`, no `eslint-disable`, no `delete`, 11 `readFileSync`-class calls in
the whole tree, `execFile` never with a shell, every credential-bearing write at
`0o600` through one atomic writer, and the five runtime invariants in `AGENTS.md`
actually enforced in code. **Nothing below is a broken feature.**

What follows is the gap between that and the standard the user set: *works
perfectly, contains nothing stupid, survives an agent code review, maximally
simple and efficient, pure-FP, guided, formatted, tested, fast and secure.*
Findings are grouped by the axis a reviewer would judge, and each says what
would be observed, not only what is wrong.

Severity: **B** blocks a fleet install · **C** correctness · **SEC** security /
supply chain · **P** hot-path cost · **FP** functional-style conformance ·
**S** simplicity / dead weight · **T** test gap · **G** guide, formatting, docs.

A finding that was in v2 and did not survive verification is not silently
dropped: it is kept with **Withdrawn** against it and the reason, so the same
claim is not re-derived later from a stale copy.

---

## 1. Blocks a fleet install

### B1 — `doctor` cannot distinguish a rejected token from a healthy install

`probeBackend` (`src/cli/doctor.ts:225`) POSTs an empty batch with a
`content-type` header and nothing else — no `Authorization`, no installation
header. Two bad outcomes from one omission:

- A **correctly** configured machine whose backend requires auth gets 401, and
  doctor prints `backend connectivity — warn: HTTP 401`. The one command an
  administrator runs to confirm a rollout warns on a healthy install.
- A machine with a **wrong or expired** token prints exactly the same line. The
  most common production misconfiguration is indistinguishable from success.

Compounding it: 401 and 403 are in `RETRYABLE_STATUSES`
(`src/transport/constants/transport.constants.ts:41`), so a rejected credential
never reaches `stats.recordRefusal` — `delivery.rejected` and
`lastRefusalStatus` stay empty. The backlog grows for up to `maxEventAgeDays`
(7) and then deletes itself. `status` says "N pending"; `doctor` warns only
after 24 h of staleness, and never says why.

**Fix, diagnosis only**: send `edgeHeaders(token, installationId)` on the probe
and report semantically — 2xx `ok`, 401/403 `fail: token rejected`, anything
else `warn`. This finding covers **what `doctor` says**, nothing else. What the
*delivery path* does after a 401/403 is one decision, stated once in
[SEC3](#sec3--the-401403-decision-normative); B1 deliberately makes no claim
about retries, because v2 made two contradictory ones.

### B2 — CI never runs the Node floor the package promises

`engines` declares `node >=20`, `README.md:14` says "Requirements: Node.js 20+",
and `.github/workflows/release.yml` builds and tests on Node **24 only**. The
code uses recent APIs (`AbortSignal.timeout`, `fs.realpathSync.native`,
`Array.prototype.at`), so the floor is an advertised number that nothing
verifies. That is a promise the package already made and does not keep.

**Fix**: matrix the `verify` job over `node: [20, 24]`. Three lines.

**Windows and macOS are explicitly *not* part of this finding.** The repository
states the opposite of a support claim in three places, and the audit was wrong
to treat it as a broken promise:

- `docs/ENTERPRISE_DEPLOYMENT.md:10` — "Windows is not currently a verified
  deployment target";
- `docs/ARCHITECTURE.md:230` — hooks are "shell-command based and untested on
  Windows in this MVP (documented limitation)";
- `spec.md:329` — "Windows remains a documented limitation, unchanged".

Two `src` files do branch on `win32` and no test mentions it, but adding a
Windows/macOS CI matrix **widens the support contract** — it commits the project
to fixing what the matrix then finds (shell quoting, permissions, provider
paths, uninstall). That is a product decision for the maintainer, not a defect,
and it is not a pilot blocker. It appears in the gate list as a decision, at the
bottom, with no size estimate. (v2 also asserted "fleets that are 40 % Windows";
that number had no source and is withdrawn.)

### B3 — `process.exit()` immediately after writing the hook's answer

`src/cli.ts:157` ends with `main().then((code) => process.exit(code))`. On POSIX,
`process.stdout` to a pipe is asynchronous and `process.exit` does not flush a
queued write. The hook's stdout **is** the agent protocol: for a budget refusal
it carries the `block` JSON, and for Antigravity an empty stdout means "no
decision at all". Low probability, total loss when it hits, one line to close.

**Fix**: set `process.exitCode` and return, or await a drain before exiting.

---

## 2. Correctness

### C1 — a degraded turn summary is attributed to nobody

`closeTurnLocked` resolves identity through `developerIdentity(...)` — config
email, else `git config user.email` (`src/turns/turn-tracker.ts:300`).
`fallbackSummary`, the degraded close used when assembly throws, reads
`options.config.developerEmail` verbatim (`src/turns/turn-tracker.ts:337`). On
the common machine that sets no `developerEmail` and relies on git, that summary
carries **no** `developer_id`: it lands in the backend attributed to nobody —
and it is exactly the turn its developer is least likely to notice missing from
their spend.

**Fix**: one call site. Make `fallbackSummary` async and use
`developerIdentity`, or resolve the identity once in `trackTurn` and pass it to
both.

### C2 — the queue's product-record guard exists twice, and the exported one is dead

`src/events/product-event.ts:42` exports `isProductEvent`, whose JSDoc says "the
guard the offline queue uses before draining an entry" and explains that the two
copies "drifted once". Nothing in `src/` imports it — only
`tests/repo-snapshot.test.ts` does. The queue uses a private `isProductEntry`
(`src/transport/queue.ts:537`) that re-implements the same membership test. The
comment documents a bug that is currently re-introduced.

**Fix**: `queue.ts` imports `isProductEvent`; delete `isProductEntry`.

### C3 — `cooldown.clear()` is the one unguarded write on the delivery path

`trip()` and the stats writes swallow their failures with a stated reason.
`clear()` (`src/transport/cooldown.ts:60`) does not. It is awaited in
`deliverEvents` *after* a successful send and *before* the drain
(`src/transport/delivery.ts:90`), so an `EACCES`/`EPERM` there aborts the
deliver stage and the backlog is not drained — on the one hook that just proved
the backend healthy.

**Fix**: the same `try {} catch {}` shape as `trip()`.

### C4 — `DecisionCache.write` is a read-modify-write with no lock

`src/enforcement/decision-cache.ts:51`. Two hooks closing concurrently can lose
an entry. Benign by construction — a lost entry is a cache miss and the next
hook asks again — and recorded only so a reviewer does not mistake it for an
oversight. A lock here would cost the gate more than the miss does. **No fix
proposed.**

---

## 3. Security and supply chain

The privacy design is the strongest part of the package: two independent
defences (sensitive-key drop *and* content pattern scrub), unconditional and
independent of capture settings, pre-compiled patterns, everything
credential-bearing at `0o600` through one atomic writer that preserves the
target's mode, tokens kept out of `argv` in both MDM templates, and a partition
name that is a digest rather than the token.

Most of the findings below are at the edges of that design. **SEC0 is not** — it
is a gap in the middle of it, and it is the reason this section leads with it
rather than with the hardening items.

### SEC0 — the sanitizer never sanitizes object *keys*, so a secret in a key is transmitted verbatim

The most direct hole in the privacy design, and v2 recorded it only as a missing
test. `walk` decides *whether to redact the value* from the key
(`SENSITIVE_KEY_PATTERN.test(key)`) and then writes the key through untouched
(`src/privacy/sanitizer.ts:55`). The key itself never reaches `sanitizeText`.
Verified against the built artifact:

```
sanitizeValue({ 'sk-abcdefghijklmnopqrstuvwx': 'value', note: 'see sk-abcdefghijklmnopqrstuvwx' })
→ {"sk-abcdefghijklmnopqrstuvwx":"value","note":"see [REDACTED]"}
     ↑ key survives in full                    ↑ value correctly scrubbed
sanitizeValue({ 'ghp_abcdefghijklmnopqrstuv123456': 1 })
→ {"ghp_abcdefghijklmnopqrstuv123456":1}
```

The same string is redacted in a value and shipped in a key, in the same
object, in the same pass. Keys of exactly this shape occur in real captured
material: a tool result that dumps a keyed map (credential → metadata, token →
scopes, URL-with-credentials → status), an environment or config object read by
a tool, a cache or rate-limit map keyed by API key. `SECURITY.md` names
"secrets … surviving the sanitizer in events, logs, queue files, or diagnostics
output" as a highest-priority security bug, and `AGENTS.md` §4 states "secrets
are never transmitted" as a non-negotiable invariant. This is that bug, and it
is reachable without any attacker at all — a developer's own tool output is
enough.

**Fix**: run keys through `sanitizeText` too. One line, with one decision to
make explicitly: two distinct keys can redact to the same string, so the
collision rule must be stated and tested (last-writer-wins silently merges
entries, which is its own data-loss bug — prefer a suffixed
`[REDACTED]`/`[REDACTED:2]`, or drop the entry entirely and count it). This is a
gate item, not a hardening nicety.

### SEC1 — the redaction walk builds output objects that a `__proto__` key can retarget

`src/privacy/sanitizer.ts:55` — `out[key] = ...` on an object literal. The same
shape is in `compact()` (`src/core/object.ts:22`) and `omitKeys()`
(`src/core/object.ts:44`). Verified on Node 24:

```
input  : JSON.parse('{"__proto__":{"polluted":1},"a":2}')
out    : keys = ['a']            ← the __proto__ entry is silently dropped
         Object.getPrototypeOf(out) !== Object.prototype   ← true
         out.polluted === 1      ← phantom inherited property
```

**The demonstrated consequence is data integrity, not attribution poisoning.** A
`__proto__` own property (which is what `JSON.parse` produces — it does not set
a prototype) **vanishes from the sanitized copy** instead of being kept or
redacted, and the copy's prototype is silently replaced. So the record that is
queued, audited and sent is not the record that arrived, and the one key most
likely to be present for a bad reason is the one key guaranteed to disappear.

**What v2 claimed and could not show**: that this reaches `firstString()` /
`firstNumber()` (`src/core/object.ts:97,119`), whose `record[key]` resolves
through the prototype chain, and thereby poisons model/developer/token
attribution. Checked every call site of both:
`src/otlp/normalize.ts:142-221` and `src/providers/shared/tooling.ts:110,124` —
all of them read the **raw** `JSON.parse` payload, *before* the sanitizer runs.
Every consumer of `sanitizeValue`'s output
(`src/events/enrich.ts:42`, `src/privacy/product-capture.ts:18-31`,
`src/turns/turn-tracker.ts:316,349`) is terminal: serialize and send. **No path
from a retargeted prototype into an attribution field exists today.** The claim
is withdrawn; the primitive is real, the impact was speculation.

Global `Object.prototype` is not polluted either (the target is a fresh
literal), so this is neither RCE nor a live attack — it is an integrity defect
in the module whose whole job is to be trustworthy, ranked accordingly.

**Fix**: build all three with `Object.create(null)` and spread into a plain
object where one must escape. The alternative v2 offered — "skip the
`__proto__`, `constructor` and `prototype` keys" — is **withdrawn**: it
preserves exactly the silent data loss this finding is about. Two lines each,
plus the regression test that is missing today (see T2).

**Separately, as defence in depth and not because a path was found**: readers
that resolve untrusted keys (`firstString`, `firstNumber`, `asRecord` consumers)
should read own properties only (`Object.hasOwn` before the lookup). Marked
unproven on purpose, so implementation does not treat it as a fix for a known
exploit.

### SEC2 — the config schema accepts any URL scheme, so the bearer can travel over `http://`

`configSchema` validates `endpoint`, `eventsUrl`, `otlpUrl`, `enforcementUrl`
and every `roots[*]` equivalent with `z.string().url()`
(`src/config/schemas/config.schema.ts:132-150`). Verified against the pinned
zod: `z.string().url()` accepts `http://…`, `file:///etc/passwd`,
`javascript:alert(1)`, `data:…` and `ftp://…` alike.

The interactive/MDM path *is* guarded — `assertHttpUrl` in
`src/enrollment/manual-enrollment.ts` enforces
`ALLOWED_PROTOCOLS = {https:, http:}`. But the schema is what governs every
**subsequent load** of the file, and hand-editing `~/.agentwatch/config.json` is
the documented way to enable content capture (README, `examples/mdm/README.md`).
A one-character slip or a templating bug in an MDM payload therefore ships the
`Authorization: Bearer <token>` header, plus every captured prompt, in cleartext
over plain HTTP, with no warning from `setup`, `status` or `doctor`.

**Fix**: put the check in the schema, where it applies on every read — a
`.refine()` allowlisting `https:` (and `http:` for loopback only), plus a
`doctor` line that names a non-loopback `http://` endpoint as a finding. Then
`assertHttpUrl` can be deleted, so the rule exists once.

### SEC3 — the 401/403 decision (normative)

**This section is the single source of truth for post-401/403 behaviour.** v2
stated it three incompatible ways — B1 said the batch is still retried, SEC3
said sends stop, and `spec.md:221` (FR-005) requires retries to continue
"exactly as today". Any generator fed those three produces mutually exclusive
tasks and tests, so the semantics are fixed here and everything else defers to
it.

**The problem.** `RETRYABLE_STATUSES` includes 401 and 403
(`src/transport/constants/transport.constants.ts:41`) with the comment "usually
transient misconfiguration". A revoked or rotated token is neither transient nor
silent-worthy: the edge re-presents a rejected credential on every hook for up
to `maxEventAgeDays` (7), which reads to the backend's security monitoring as
low-rate credential stuffing from every developer machine at once, and to the
operator as nothing at all.

**The decided semantics.** After a 401 or 403 from the events endpoint:

1. **The record stays queued.** `AGENTS.md` §4 — "a product record is never
   discarded on a failed send" — is unchanged and untouchable. Nothing here
   deletes, ages out faster, or drops an entry.
2. **A persisted auth-block is recorded**, keyed by
   `(destination, credential fingerprint)`. The fingerprint is the token digest
   the queue already computes for its partition name
   (`partitionName` in `src/transport/queue-partition.ts`) — reuse it; do not
   introduce a second way to name a credential, and never store the token.
3. **Automatic sends for that pair are suspended** while the block stands: no
   direct send, no drain attempt. Other destinations and other credentials on
   the same machine are unaffected — the block is per pair, exactly like the
   cooldown and the stats file.
4. **The block is lifted only by a change of fingerprint** (a new token, a new
   destination) or by an explicit operator action. It does **not** expire on a
   timer: a rejected credential does not become valid by waiting, and a timer is
   how this became invisible in the first place.
5. **`doctor` always performs its authenticated probe**, block or no block. The
   diagnostic is the operator asking a direct question and must never be
   answered from cached local state; a 2xx there is also the natural signal to
   clear the block.
6. **`status` reports the block** — the refusing status, when it started, and
   how many records are held behind it — and the delivery tally records the
   refusal (`stats.recordRefusal`), which today it never sees because the status
   is classified retryable.

**Consequences for the spec**: FR-005 ("A rejected credential MUST continue to
be retried rather than discarding records, exactly as today") must be rewritten.
Its intent — *do not lose records* — is preserved by (1) and is the part worth
keeping; its mechanism — *keep retrying forever* — is the defect. FR-004 stays
as written and is satisfied by (6).

**Not decided here, deliberately**: whether the operator action in (4) is a new
subcommand or a documented `setup` re-run. That is a UX choice with no bearing
on the invariants, and the specification should state the requirement, not the
command.

### SEC4 — an unbounded response body is parsed on the hook's critical path

`readCounters` does `await response.json()` with no size or content-type guard
(`src/transport/http-transport.ts:101`), and so does the enforcement client
(`src/enforcement/decision-client.ts:37`). A compromised, misconfigured or
merely proxy-intercepted endpoint can answer 200 with an arbitrarily large body
and make the coding agent's hook allocate it. The send timeout bounds the
*request*, not the decode.

**Fix**: check `content-length` and cap the read (both bodies are a handful of
integers; 64 KB is generous), and pin `redirect: 'error'` on both calls so an
endpoint cannot silently retarget a batch that carries a bearer.

### SEC5 — the edge permanently tightens agent config files it does not own, and never restores them

`gemini.otel.ts:182` writes Gemini's `settings.json` with `SECRET_FILE_MODE`
**unconditionally**, whether or not the env block carries a token; the codex
configurator does the same thing *conditionally* (`codex.otel.ts:113`), which is
the right shape. Worse, on uninstall both write with no mode
(`gemini.otel.ts:230`, `codex.otel.ts:159`), and `writeFileAtomic` preserves the
target's current mode by design — so the file keeps `0600` forever after the
token is gone. On a shared or multi-user workstation the edge has silently
changed the permissions of another tool's file and cannot undo it.

**Fix**: pass `SECRET_FILE_MODE` only when the rendered block actually carries a
credential, and record the pre-existing mode in the install state so uninstall
restores it. This is also the one place the package violates its own "only
AgentWatch-owned entries are ever touched" invariant — applied to file
metadata rather than to file content.

### SEC6 — the supply chain around the package is weaker than the package

**Corrected from v2, which was wrong on two rows.** The release tooling is
stronger than that draft claimed, and the claims are withdrawn:

- **A CycloneDX SBOM is produced.** `scripts/release-artifacts.mjs:25` runs
  `npm sbom --sbom-format=cyclonedx --omit=dev`, asserts `bomFormat`, writes
  `edge.cdx.json` into the release artifact and includes it in `SHA256SUMS`;
  `docs/ENTERPRISE_DEPLOYMENT.md:15` documents it and is honest that checksums
  do not authenticate a publisher. v2's "no SBOM" is **false**.
- **`SECURITY.md` exists, is shipped in the tarball, and carries a private
  disclosure channel** (GitHub Security Advisories, "acknowledgement within a
  few business days") plus an explicit list of what counts as a
  highest-priority security bug. v2's "no `SECURITY.md` link to a disclosure
  SLA" is **false** as written; if there is a gap it is that the response
  window is prose rather than a committed SLA, which is not worth a finding.

Also worth crediting rather than flagging: `release-artifacts.mjs` packs with
`--ignore-scripts`, allowlists every tarball entry against a regex, rejects
`..` path segments, asserts each `exports` target is present, and caps the
unpacked size at 2 MB. That is a better packaging check than most packages have.

What is genuinely missing:

| Gap | Where | Consequence |
|---|---|---|
| Actions referenced by mutable tags (`actions/checkout@v4`, `setup-node@v4`, `upload-artifact@v4`, `download-artifact@v4`) | `release.yml` | a compromised tag runs in the job that builds the published tarball; SHA pinning is the standard control |
| `npm ci` runs dependency lifecycle scripts in the verify job | `release.yml` | install-time code execution from any transitive dep — `--ignore-scripts` is already used at pack and publish, just not at install |
| No `npm audit` / `osv-scanner` step, no CodeQL, no Dependabot config | `.github/` holds exactly one file | no vulnerability signal between releases; the SBOM says what is in the tree, nothing checks it for advisories |
| No signed tags | repo | provenance covers the npm artifact, not the git history it was built from |
| `patch-package` is a devDependency with no `patches/` directory and no `postinstall` | `package.json:87` | a dead dependency a reviewer must stop and ask about |

None of these is exploitable today. All are answers a large company's review
asks for in writing, and the cheapest time to have them is before the first
pilot.

---

## 4. Performance on the hook path

The shape is the finding: **module loading dominates the hook's own work — a
median 33.3 ms to `import` the hook path before a single byte of the payload is
read, of which the provider registry is 22.9 ms** — and the agent fires roughly
ten hooks per turn. Read those two numbers with the method note in the baseline
section: they are medians over fresh processes, they are not additive, and no
total wall-clock figure for a hook is claimed. Everything below is inside that
budget or next to it.

### P1 — the eager provider registry dominates the hook's import cost

`src/cli/hook.ts` imports `../providers/registry.js`, which eagerly imports all
five providers with their adapters, schemas and constants. Median import cost
(N = 15, fresh process each): `registry.js` **22.9 ms** against
`dist/cli/hook.js` **33.3 ms** for the entire hook path; one provider adapter
alone is **10.3 ms**. `cli.ts` goes to real trouble to lazy-import command
modules "so the hook path does not pay their startup" and then loads four agents
the invocation will never touch.

**Fix**: `getProvider(id)` becomes a five-entry map of `() => import(...)`
loaders. `setup`, `status` and `doctor` keep the eager list they genuinely need.
It removes code rather than adding it, and it cannot change behaviour — the
registry has no state.

**Bound, not a prediction**: the saving is at most `22.9 − 10.3 ≈ 12 ms` of
median import time, and probably less, because the isolated measurements each
pay for a shared dependency graph (see the method note in the baseline
section). The implementation must re-measure with the same harness and record
before/after; "expected ~8–10 ms per hook, ~80–100 ms per turn" in v2 was
arithmetic on non-additive samples and is withdrawn.

### P2 — every hook reads the whole queue backlog, twice over

`deliverEvents` calls `queue.drain` on **every** invocation, including the
majority that emit nothing (`src/transport/delivery.ts:57`). `collectDue`
(`src/transport/queue.ts:224`) lists the partition and `readFile` + zod-parses
**every** entry to find the due ones; default `maxQueueEvents` is 2000. During
any backend outage each of ~10 hooks per turn reads and parses up to 2000 small
JSON files inside the agent's critical path — precisely what `AGENTS.md` §3
forbids. `enqueue` → `enforceBound` re-reads them all whenever the bound is
exceeded, and `oldestPendingAgeMs` (`src/transport/queue.ts:89`, used by `doctor`)
makes a third
full pass.

**The v2 fix was wrong and is withdrawn.** It proposed renaming entries to
`<nextAttemptAt>-<id>.json` "with no new machinery". That breaks the property
the queue is built on. `enqueue` dedupes by *computing the path from the event
id alone* and skipping an existing file
(`src/transport/queue.ts:56`, `fileFor` at `:364`), so:

- **idempotency dies**: the same event id enqueued at a different moment
  produces a different filename and therefore a second copy of one record;
- **every backoff becomes a rename**: `recordFailure` currently rewrites
  content in place; with the due time in the name it must rewrite *and* move,
  which is a two-object operation with no atomic primitive behind it — a crash
  between them leaves a duplicate or an entry no scan will pick up;
- **oldest-first is lost**: sorting by `nextAttemptAt` orders by *when an entry
  may next be tried*, not by when it was queued, and after any backoff those
  two orders differ.

All three are `spec.md` FR-009 verbatim — "MUST continue to drain oldest-first,
MUST remain idempotent against duplicate enqueue, and MUST NOT lose an entry to
a crash at any point in a pass". So the cheap version of this optimisation does
not exist.

**What to do instead, in this order:**

1. **Bound the work, keep the layout** (safe, small, no format change): stop
   `collectDue` once it has `drainBatchSize` due entries, and skip the drain
   entirely on hooks that emit nothing unless a cheap trigger says otherwise
   (a directory mtime, or a marker written by the last enqueue). This alone
   removes the pathological case — ten hooks per turn each parsing 2000 files —
   without touching a single filename.
2. **Only if that is not enough**, design a real index: a separate due-time
   index or bucket directory that is *derived* state, rebuildable by a full
   scan, with the entry file itself remaining the single authority named by
   event id. That needs its own crash-recovery protocol (what happens when the
   index and the entries disagree) and its own tests, and it is a separate
   piece of work — not a line in this gate list.

The measured cost stands; the proposed remedy does not.

### P3 — the outgoing turn summary is deep-walked and regex-scrubbed three times (observation, not a gate item)

Corrected count. The summary object itself is sanitized three times:

1. `closeTurnLocked` sanitizes the built summary (`turn-tracker.ts:316`) — and
   `alignContentEvidence` depends on running over the *sanitized* text, so this
   pass is load-bearing;
2. `trackTurnStage` → `applyProductCapture` (`hook-pipeline.ts:258`) — this is
   what decides the shape that gets **queued**, so it is also load-bearing;
3. `HttpTransport.send` → `applyProductCapture` (`http-transport.ts:52`).

The fourth pass v2 counted (`src/events/enrich.ts:42`) is over the **Stop
lifecycle event**, a different object, not the summary. Each string is walked
against eleven global regexes up to 8 KB per pass, plus a full object rebuild.

**v2's fix — remove the gate from `HttpTransport.send` — is withdrawn.** The
transport is the last mandatory boundary before the network, it is a *tested*
boundary (`tests/enterprise-privacy.test.ts:67-106` construct `HttpTransport`
directly with capture configs and assert the gating there), and deleting it
would make "no content leaves without consent" depend on every present and
future direct caller remembering to sanitize. That trade — a few milliseconds
against the last enforcement point for the package's top-priority invariant —
is not worth making, and certainly not worth making blind.

**What this finding actually asks for**: measure the per-pass cost first
(unmeasured today — the regex figures in the baseline are for a single 8 KB
string, not for a realistic summary), and if it matters, make the *record*
carry proof it was gated under the current policy (a policy fingerprint the
transport can check and short-circuit on) rather than removing the check.
**Removed from the gate list**; it stays here as a documented observation.

### P4 — the session sweep runs on every close

`processEvent` calls `store.sweep(TURN_STATE_TTL_MS)` after every
`generation.completed` **and** every `session.ended`
(`turn-tracker.ts:132,139`). `sweep` lists the turns root and, per session
directory, `readdir` + `stat`s every file — hundreds of syscalls per closing
turn on a busy machine, to discover that nothing is 24 h old yet.

**Fix**: a `last-sweep` mtime marker in the turns root, swept at most hourly.
Same guarantee, one `stat` on the common path.

### P5 — the transcript settle loop allocates up to 24 MB per Stop

`TRANSCRIPT_TAIL_BYTES` is 4 MB and `USAGE_RETRY.attempts` is 6; each pass
allocates a fresh 4 MB buffer, decodes it and `split('\n')`s it into thousands
of strings (`src/turns/transcript.ts:159`). The tail is re-read because the file
grows — but the bytes already read do not change.

**Fix**: reuse one buffer across the passes of a single `readUntilSettled` and
read only the bytes appended since the previous pass. If that is judged too much
machinery, dropping the tail to 512 KB is a one-line change with the same effect
on the common turn.

### P6 — the config file is read twice per hook, three times on setup

`runHook` → `loadConfig(paths)` (`src/cli/hook.ts:141`), then stage one →
`loadEffectiveConfig` → `loadConfig` again (`src/config/repo-config.ts:94`) —
with the value it needs already in hand as `globalConfig`. `saveConfig` re-reads
the file a third time for `storedCapture`.

**Fix**: `loadEffectiveConfig` takes the already-loaded `ConfigLoadResult`.

### Not a finding, recorded so nobody "fixes" it

The redaction patterns are **not** ReDoS-prone. Measured on Node 24: the
private-key block, the `assignment` pattern and the `Bearer` pattern each
complete in 0–1 ms against an 8 KB adversarial input, because
`MAX_STRING_LENGTH` truncation happens *before* the patterns run
(`src/privacy/sanitizer.ts:11`). Leave the truncate-then-scrub order alone; it
is load-bearing.

---

## 5. Functional-programming conformance

`STYLEGUIDE.md` §1 asks for pure functions, no argument mutation, no `else`, and
I/O separated from computation. The code delivers the hard parts of that: no
`else` in 19,587 lines, `readonly` types throughout, `mergeDeltas`-style
accumulator folding, `runFlow` stages over one immutable state.

### FP1 — eleven `class` declarations, and not one of them holds mutable state

`SnapshotStateStore`, `DeliveryStats`, `BackendCooldown`, `EventQueue`,
`HttpTransport`, `DecisionCache`, `TurnStateStore`, `ManualEnrollmentProvider`
and the three OTel configurators. `grep` for a non-`readonly` private field
returns **zero** hits: every one is a constructor-injected bag of paths, config
and clock, plus methods that read and write the filesystem. They are namespaces
with a `new` in front of them.

**The recommendation is to document the exception, not to convert them.** v2
offered conversion and documentation as equal options; that was wrong on the
merits. Replacing a class that writes files with a factory returning closures
changes the syntax and nothing else: the effects are identical, the mutable
state is the filesystem either way, and `readonly` on an injected dependency
only freezes the reference, never the world behind it. Converting eleven I/O
adapters is mechanical churn across the most invariant-dense modules in the
package — the queue, the decision cache, the turn store — with no behavioural
benefit and a real regression risk, which is the opposite of what an enterprise
readiness pass is for.

So: add one line to `STYLEGUIDE.md` §1 — *stateful I/O adapters may be classes;
domain logic and transformations must be pure functions* — and leave the code
alone. The finding is that the **guide is silent**, and an agent reviewer told
"this codebase is pure FP" will read eleven classes as drift. One sentence
closes it.

Worth noting where the FP discipline actually paid off: because no class holds
mutable state, the eleven of them are trivially testable and the boundary
between "computes" and "touches the disk" is already clean. That is the property
the guide was after, and the code has it.

### FP2 — the guide forbids what `logger.ts` needs, and says so only in a comment

`let verbose` (`src/core/logger.ts:11`) is process-wide mutable state, honestly
documented as "the module's one deliberate mutable cell". It is the right call.
It belongs in the guide as a named exception, not only at its own definition —
otherwise the next contributor (or generator) reads it as permission.

### FP3 — `pipe()` is dead, and it is half of the guide's headline idiom

`STYLEGUIDE.md` §1.4 presents `runFlow` **and** `pipe(...)` as the two
composition primitives. `runFlow` is used; `pipe()` and its five overloads
(`src/core/pipe.ts:87`) have **zero call sites**. A reviewer reading the guide
first will look for `pipe` in the code, find only its definition, and correctly
conclude that either the code or the guide is stale.

---

## 6. Simplicity

186 files for 19,587 lines is 105 lines per file: 17 barrels, 30 `*.types.ts`,
29 `*.constants.ts`, 9 `*.schema.ts` and 101 logic files. The layering is real
and mostly earns itself. Three places do not.

### S1 — dead code

| What | Where | Note |
|---|---|---|
| `pipe()` + 5 overloads | `src/core/pipe.ts:87` | zero call sites; see FP3 |
| `COMMANDS` | `src/cli/constants/cli.constants.ts:13` | zero references; `cli.ts` switches on literals |
| `providerEventId()` | `src/events/event-id.ts:41` | referenced only by its own test |
| `RE_NEEDS_QUOTING`, `RE_QUOTE_ESCAPE` | `src/providers/constants/provider.constants.ts:41` | duplicates of the live copies in `cli.constants.ts`; the provider copy is unused |
| `CONTENT_CAPTURE_FLAGS` | `src/config/constants/config.constants.ts:104` | identical value to `CONTENT_CAPTURE_KEYS` in the same file |
| `isProductEvent` | see C2 | exported, dead, and re-implemented privately |
| `patch-package` | `package.json:87` | devDependency, no `patches/`, no hook |

Seven items is not a lot. It is, however, seven things a reviewer finds in the
first ten minutes with `grep`, and each one costs the package a little of the
credibility the rest of it earns.

### S2 — `src/enrollment/` is four files and an interface for "ask for a URL"

A provider interface, a types module, a module that only re-exports those types
(`enrollment-provider.ts`), and the single `ManualEnrollmentProvider` — whose
own doc comment promises a `RemoteEnrollmentProvider` later, and whose `enroll`
opens by **throwing** on `setupUrl`, the very input the abstraction exists for.
`setup.ts` is the only caller. This is the textbook YAGNI case and it is exactly
what "no abstractions for hypothetical requirements" rules out.

**Fix**: one exported function `resolveEnrollment(input)` in one file. The
interface returns the day a second implementation does.

### S3 — 17 barrel `index.ts` files that nothing imports

`AGENTS.md` §2 mandates a public `index.ts` per module and every module has one.
Nothing in `src/`, `tests/` or `example/` imports a single one — internal code
imports concrete files, and `package.json` `exports` publishes five specific
files, none of them a barrel. They are ~250 lines of export lists that must be
kept in step with every rename, and they are what keeps dead exports (S1)
looking used.

A **convention decision, not a defect** — flagged rather than changed. Delete
them and drop the rule from `AGENTS.md`, or keep them and accept the
maintenance. The middle option (keep the file, export only what `package.json`
publishes) is worse than both.

---

## 7. Tests

485 passing tests in 12.6 s, and the hard cases are covered: concurrent Stops
racing for one turn, exactly-once transcript claims, queue fairness across
partitions, the off switch proving hooks skip stdin *and* networking *and*
diagnostics. This is a well-tested package. The gaps are about what a reviewer
cannot see.

### T1 — coverage is neither measured nor enforced

No `@vitest/coverage-v8` in `devDependencies`, no `coverage` block in
`vitest.config.ts`, no threshold in CI. "485 tests pass" is not an answer to
"what fraction of the enforcement path is exercised", and it is the question an
enterprise review asks in writing.

**Fix**: add the provider, a `coverage.thresholds` floor for
`src/privacy`, `src/enforcement`, `src/transport` and `src/turns`, and print the
summary in CI.

### T2 — the most security-critical module has the thinnest test file

`tests/privacy.test.ts` is **71 lines** and `tests/enterprise-privacy.test.ts`
148, against 512 for the Cursor provider. Nine cases cover the happy paths of
each pattern. Not covered, and each one is a hole in the "secrets are never
transmitted" invariant:

- a `__proto__` key in a sanitized payload (SEC1 — this test would have caught
  it);
- a secret **straddling** the 8 KB truncation boundary (measured: a secret
  starting at byte 8180 is cut mid-token and no partial survives, so the
  current behaviour is safe — it is simply unasserted);
- a secret in an object **key** rather than a value — this one is not a
  missing test but a live defect; see [SEC0](#sec0--the-sanitizer-never-sanitizes-object-keys-so-a-secret-in-a-key-is-transmitted-verbatim);
- `Symbol` keys, `Map`/`Set`/`Date`/`BigInt` values through `walk`;
- a cyclic object (depth cap is the intended defence — assert it);
- the truncation itself, which drops the tail **silently** while the depth cap
  leaves a `[TRUNCATED]` marker; that asymmetry is either a bug or a
  documented decision, and today it is neither.

**Fix**: a property-based pass over the sanitizer (generate payloads containing
a known secret, assert the secret never survives, for arbitrary nesting and
key shapes) is worth more here than another dozen examples.

### T3 — no test runs on the supported Node floor

See [B2](#b2--ci-never-runs-the-node-floor-the-package-promises). Node 20 is
promised by `engines` and the README and is never exercised — that is the test
gap. Windows is a different thing: two `src` files branch on `win32` and no test
mentions it, but the documents disclaim Windows support, so that is a coverage
gap only if the maintainer decides to make Windows a supported target.

### T4 — the queue's bound and expiry are tested by example, not by invariant

`maxQueueEvents`, `maxEventAgeDays`, the backoff jitter band and the isolation
cap interact, and the property that matters — *a product record is never
discarded on a failed send* — is a statement about all schedules, not about the
three the tests enumerate. This is the other place property-based testing pays
for itself.

### T5 — the suite is not reproducible: two HTTP tests can outlive the timeout

**This finding exists because the v2 baseline could not be reproduced.** On the
audit machine `npm test` gives 485/485 in 12.6 s, and
`tests/queue-partition.test.ts` passes 3/3 in isolation in 289–647 ms. On a
reviewer's machine the same suite **failed on the 15 s timeout** at
`tests/queue-partition.test.ts:183` ("delivers each project's backlog under its
own bearer, never the other's"), reproduced on a targeted re-run, and the
process then **did not exit on its own**.

The mechanism is visible in the code and does not depend on which machine is
right. Two suites bind a real loopback HTTP server and drive real `fetch`
through it from `runHook`:

- `tests/queue-partition.test.ts:174` — `await new Promise((resolve) => server.close(() => resolve()))`
- `tests/enforcement.test.ts:375` — the same line

`server.close()` stops accepting new connections and then **waits for existing
ones to end**. Node's `fetch` (undici) keeps connections alive by default, so
teardown blocks until a keep-alive socket times out — with nothing in the tree
calling `server.closeAllConnections()` (verified: zero occurrences). Add
vitest's default parallel file execution and a 15 s `testTimeout`, and the
teardown of a test that does its actual work in 300 ms can consume the whole
budget on a loaded machine. That is exactly the observed failure and the
observed hang.

**Fix**: `server.closeAllConnections()` before `server.close()` in both suites
(and set a low `server.keepAliveTimeout`), so teardown is bounded by code rather
than by socket timers.

**Consequence for this document**: no claim of the form "485/485 passing" is
worth anything until this is fixed. The baseline table says so explicitly, and
"the suite is green" must not be a precondition anyone trusts in the meantime.

---

## 8. Guide, formatting, docs

### G1 — there is no formatter, so "correct formatting" is unenforced

No Prettier, no `.editorconfig`, no `@stylistic` preset — only four hand-picked
stylistic rules (`padding-line-between-statements`, `semi`, `quotes`) plus the
`no-restricted-syntax` bans. Indentation, line width, member ordering, arrow
parens, trailing commas, object-literal line breaking and import ordering are
therefore **reviewer opinion, not CI**. Today the code is consistent because one
author (and one model) wrote it; the first outside contributor is where that
ends.

**Fix**: `@stylistic/eslint-plugin`'s recommended preset (already a dependency)
plus `import-x/order`, or Prettier with a `--check` step in CI. Either makes
formatting a fact instead of a habit.

### G2 — the compiler is left holding back three checks that would enforce the guide

`tsconfig.json` sets `strict` and `noUncheckedIndexedAccess` (good, and rare)
but not:

- `noUnusedLocals` / `noUnusedParameters` — would have caught most of S1;
- `verbatimModuleSyntax` — would *enforce* `AGENTS.md`'s "prefer type-only
  imports" instead of leaving it to review;
- `exactOptionalPropertyTypes` — meaningful in a package whose JSON encoding
  treats "absent" and "undefined" as different things (`compact()` exists
  precisely because of that distinction).

### G3 — the guide and the code disagree in three places

Each is small; together they are what makes an agent reviewer distrust the guide
and start second-guessing the code:

| `AGENTS.md` / `STYLEGUIDE.md` says | The code does |
|---|---|
| every module exposes a public `index.ts` (§2) | 17 exist, 0 are imported (S3) |
| `runFlow` **and** `pipe(...)` are the composition idioms (§1.4) | `pipe()` has no call sites (FP3) |
| pure functions, no side effects in core logic (§1) | 11 stateful-looking classes, no stated exception (FP1) |
| — | `let verbose` module state, documented only in place (FP2) |

**Fix**: one pass over both documents so that every rule in them is either
enforced by `eslint`/`tsc` or explicitly marked as a judgement call — and delete
any rule the code has decided against. A guide that is 100 % true is worth more
than a guide that is 90 % aspirational.

### G4 — documentation is strong; two things are missing for an enterprise reader

549 lines across `ARCHITECTURE.md`, `DATA_HANDLING.md` and
`ENTERPRISE_DEPLOYMENT.md`, plus a 255-line README and working Jamf/Intune
templates. Genuinely above the bar for a package this size. Missing:

- `DATA_HANDLING.md` does not state the **Gemini/Codex static-token exposure**
  plainly — that those two agents keep a bearer in their own config file
  because they have no header-helper, and that the edge therefore holds those
  files at `0600` (and see SEC5). `examples/mdm/README.md:127` says it; the
  document a security reviewer is handed does not.
- `ENTERPRISE_DEPLOYMENT.md` (40 lines) has no **uninstall/rollback**
  verification section, and no statement of what the edge changes outside its
  own directory. That list exists in the code (install state ownership) and is
  exactly what a change-control board asks for.

---

## 9. What is right, and must not be "improved"

Called out so a polish pass does not undo it:

- The fail-open enforcement path, and the split between `decisionSchema` and
  `cacheTtlSchema` so unreadable TTL advice cannot invalidate a refusal.
- `truncate → scrub` order in `sanitizeText`, which is what makes the pattern
  set ReDoS-immune (measured).
- Two independent redaction defences, unconditional and independent of capture
  settings.
- Queue partitioning by token digest, `unattributed/` for a backlog whose owner
  cannot be proven, and the refusal to guess an owner.
- `deriveEventId` as the queue filename — idempotent enqueue for free.
- `writeFileAtomic`'s mode preservation and its `fsync` before `rename`, with
  the reason written down.
- The snapshot flow's cache-diff-before-`git log` ordering.
- `withoutWidenedCapture`: a committed repo file can only ever narrow capture.
- `saveConfig` persisting the user's chosen flags rather than the gated ones.
- The per-provider OTel configurators, which look duplicated and are not (TOML
  vs JSON vs env block, with genuinely different ownership rules).
- Tokens kept out of `argv` in both MDM templates, with the reason in the
  script.
- `execFile` everywhere, never a shell; `windowsHide`; `maxBuffer` with
  deliberate truncated-output salvage.

---

## 10. The gate list

Ordered by what a fleet install actually depends on. Every row is either a
defect with a decided fix, or is marked as a decision needing an answer before
it can be specified. **Item 0 comes first because nothing else can be verified
until it is done.**

| # | Item | Finding | Size |
|---|---|---|---|
| 0 | `closeAllConnections()` before `close()` in the two HTTP suites, so the baseline is reproducible | T5 | XS |
| 1 | Keys sanitized, with a stated collision rule | SEC0 | XS |
| 2 | 401/403: record stays queued, persisted auth-block per (destination, credential fingerprint), automatic sends suspended until the fingerprint changes, `doctor` always probes authenticated, `status` reports the block | SEC3 | M |
| 3 | `doctor` authenticates its probe and names a rejected token | B1 | S |
| 4 | Hook stdout is flushed before exit | B3 | XS |
| 5 | CI matrix over `node: [20, 24]` | B2 | XS |
| 6 | URL scheme allowlist in the schema; `http://` flagged unless loopback | SEC2 | XS |
| 7 | Degraded turn summary resolves the same identity as every other one | C1 | XS |
| 8 | Response bodies capped; `redirect: 'error'` on both fetch calls | SEC4 | XS |
| 9 | `Object.create(null)` in the three object builders, with the regression test | SEC1, T2 | XS |
| 10 | Lazy provider loading, with before/after measured on the documented harness | P1 | S |
| 11 | Coverage measured, thresholds enforced in CI | T1 | XS |
| 12 | Bounded `collectDue` + skip the drain on hooks that emit nothing — **queue filenames unchanged** | P2 (step 1) | S |
| 13 | Property-based tests for the sanitizer (keys included) and the queue invariant | T2, T4 | M |
| 14 | Agent-file modes set only when a credential is present, and restored on uninstall | SEC5 | S |
| 15 | Throttled sweep; buffer reuse in the settle loop; single config read | P4, P5, P6 | S |
| 16 | Dead code deleted (7 items) | S1 | XS |
| 17 | Enrollment collapsed to one function | S2 | XS |
| 18 | Formatter + `noUnusedLocals` / `verbatimModuleSyntax` / `exactOptionalPropertyTypes` | G1, G2 | S |
| 19 | Actions SHA-pinned, `npm ci --ignore-scripts`, audit/CodeQL/Dependabot, signed tags | SEC6 | S |
| 20 | One line in `STYLEGUIDE.md`: stateful I/O adapters may be classes, domain logic may not; `let verbose` named as the one mutable cell; delete the dead `pipe()` half of §1.4 | FP1, FP2, FP3, G3 | XS |
| 21 | `DATA_HANDLING.md` states the Gemini/Codex token exposure; rollback section added | G4 | S |

**Blocking a pilot**: 0–9. Everything above is a defect in something the
package already promises.

**Not in the gate list, on purpose:**

| Item | Finding | Why not |
|---|---|---|
| Removing the transport-level capture gate | P3 | it is the last mandatory privacy boundary and it is tested; measure first, and prefer a policy fingerprint over deleting a check |
| Due-time in the queue filename / a due-time index | P2 (step 2) | breaks FR-009 in the cheap form; the safe form is a separate design with its own crash-recovery protocol |
| Converting the eleven classes to closures | FP1 | identical effects, mechanical churn through the most invariant-dense modules; item 20 is the answer instead |
| `Object.hasOwn` in the untrusted-key readers | SEC1 | defence in depth with no demonstrated path; do it, but do not sell it as a fix |

**Decisions, not defects** — these need an answer from the maintainer, and the
answer is worth more than the change:

| Decision | Finding |
|---|---|
| Windows / macOS CI matrix — widens the support contract that three documents currently disclaim | B2 |
| Barrel files: keep all 17 and accept the upkeep, or delete them and drop the `AGENTS.md` §2 rule | S3 |
| Whether lifting an auth-block is a new subcommand or a documented `setup` re-run | SEC3 |

---

## 11. Revision log

v2 of this document was reviewed and six items were found wrong or unusable.
All are corrected above; recording them so the next reader can tell a corrected
claim from a new one.

| v2 claim | Status | Where |
|---|---|---|
| B1 said the batch is still retried; SEC3 said sends stop; `spec.md` FR-005 requires retries "exactly as today" | **Contradiction resolved.** One normative semantics; B1 now covers diagnosis only; FR-005 must be rewritten | [SEC3](#sec3--the-401403-decision-normative) |
| `<nextAttemptAt>-<id>.json`, "no new machinery" | **Withdrawn.** Breaks dedup-by-deterministic-path, makes each backoff a two-object move, and loses oldest-first — all three are FR-009 | P2 |
| "485/485 passing" as a stable baseline | **Qualified and turned into a finding.** Not reproducible; teardown can outlive the 15 s timeout | [T5](#t5--the-suite-is-not-reproducible-two-http-tests-can-outlive-the-timeout) |
| Windows support is promised and the matrix is a six-line fix; "fleets that are 40 % Windows" | **Corrected.** Three documents disclaim Windows; the matrix widens the contract. Node 20 stays a blocker. The 40 % had no source and is withdrawn | B2 |
| SEC1 causes attribution poisoning via `firstString`/`firstNumber` | **Withdrawn.** Every call site reads the raw payload before the sanitizer; no path exists. Kept as a data-integrity defect. "Skip `__proto__`" alternative also withdrawn — it preserves the data loss | SEC1 |
| "No SBOM"; "no `SECURITY.md` disclosure SLA" | **Both false.** CycloneDX SBOM is generated, checksummed and documented; `SECURITY.md` ships with a private channel and an acknowledgement window | SEC6 |
| Four sanitize passes over the summary; remove the transport gate | **Corrected to three** (the fourth is over the Stop event) and the fix withdrawn — the transport is a tested boundary | P3 |
| Convert the eleven classes, *or* document the exception | **Single recommendation now**: document it. Closures over the same I/O are not purer | FP1 |
| Timings 16.0 / 7.5 / 4.1 ms, "~50 ms hook", "saves 8–10 ms" | **Re-measured** with N=15 fresh processes, median/p95, harness and machine stated; process wall time withdrawn as too noisy to quote; the saving is now a bound, not a prediction | Baseline, P1 |

One v2 finding was **promoted**: the sanitizer never scrubs object keys. v2 had
it as a missing test case (T2); it is a live violation of the `SECURITY.md`
top-priority class and `AGENTS.md` §4, so it is now [SEC0](#sec0--the-sanitizer-never-sanitizes-object-keys-so-a-secret-in-a-key-is-transmitted-verbatim)
and gate item 1.
