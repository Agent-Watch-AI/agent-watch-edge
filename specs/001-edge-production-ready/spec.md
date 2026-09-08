# Feature Specification: Edge production-installation readiness

**Feature Branch**: `001-edge-production-ready`

**Created**: 2026-09-08

**Status**: Draft

**Input**: User description: "Review the edge package, find its problems and weak spots, then polish it to production-installation-ready — written simply, with pure functions, no overengineering, following best practices, and satisfying all business requirements."

**Findings this specification is derived from**: [review.md](./review.md) —
revision v3, which is normative where the two disagree.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An administrator can tell a working rollout from a broken one (Priority: P1)

An IT administrator rolls the edge out to a fleet through MDM. On each machine
the install script runs setup non-interactively and then a diagnostic command,
and reads its exit code and output to decide whether that machine is reporting.
Today a machine with a rejected credential and a machine that is working
perfectly produce the same warning, and a machine whose credential is rejected
never says so afterwards either — its telemetry accumulates locally for a week
and is then deleted.

**Why this priority**: it is the difference between a deployment an organization
can trust and one that silently covers a fraction of its engineers. Every other
improvement is invisible next to reporting the wrong health.

**Independent Test**: point an install at a backend that rejects its credential,
run the diagnostic, and confirm it fails and names the credential; point it at a
backend that accepts the credential and confirm it passes with no warning.

**Acceptance Scenarios**:

1. **Given** a configured install whose credential the backend accepts, **When**
   the administrator runs the diagnostic, **Then** the backend check passes and
   no warning is raised about it.
2. **Given** a configured install whose credential the backend rejects, **When**
   the administrator runs the diagnostic, **Then** the backend check fails, the
   output names a rejected credential as the cause, and the command exits
   non-zero.
3. **Given** an install that cannot reach the backend at all, **When** the
   administrator runs the diagnostic, **Then** the backend check fails and
   distinguishes "unreachable" from "credential rejected".
4. **Given** an install whose credential the backend has started rejecting,
   **When** turns are recorded and delivery is attempted, **Then** the status
   report shows the rejection and when it last happened, rather than only a
   growing backlog.

---

### User Story 2 - Every recorded turn reaches the developer it belongs to (Priority: P1)

A developer's spend and budget position are keyed on their identity. When turn
assembly degrades — a corrupt local state file, an unreadable transcript — the
edge still emits a thin summary so the turn is not lost. That degraded summary
must be attributed to the same developer as every other one; today, on a machine
that takes its identity from git rather than from configuration, it is
attributed to nobody.

**Why this priority**: an unattributed turn is worse than a missing one — it is
counted in organization totals but in no developer's, and no budget cap can see
it. It is silent, and it happens on exactly the turns nobody is watching.

**Independent Test**: force turn assembly to fail on a machine whose identity
comes only from git, and confirm the emitted summary names the same developer as
a healthy turn on the same machine.

**Acceptance Scenarios**:

1. **Given** a machine whose developer identity comes from git and not from
   configuration, **When** turn assembly fails and the degraded summary is
   emitted, **Then** it carries the same developer identity a healthy summary
   would.
2. **Given** the same machine, **When** a healthy turn and a degraded turn are
   both recorded, **Then** both name one identity, resolved by one code path.

---

### User Story 3 - A backend outage does not slow the developer down (Priority: P2)

A developer works through a backend outage. Records accumulate locally, as
designed. Every hook the agent fires — roughly ten per turn — then attempts a
delivery pass, and each pass reads and validates the entire accumulated backlog
before deciding what is due. By the default backlog ceiling that is up to two
thousand file reads per hook, on the path between the developer and their agent's
next action. When the outage ends, nothing is lost; while it lasts, the developer
pays for it on every keystroke.

**Why this priority**: it degrades the experience precisely when the product is
already failing, and it contradicts a stated invariant of the package. It is not
a correctness bug, which is why it ranks below the two above.

**Independent Test**: fill the backlog to its ceiling, run one hook, and count
the entries read; the count must be bounded by the drain batch size rather than
by the backlog size.

**Acceptance Scenarios**:

1. **Given** a backlog at the configured ceiling, **When** one hook runs a
   delivery pass, **Then** the number of backlog entries read and validated is
   bounded by the drain batch size and does not grow with the backlog.
2. **Given** a backlog at the ceiling, **When** the backend recovers, **Then**
   the backlog drains oldest-first, exactly as it does today, and no entry is
   lost or sent twice.
3. **Given** any backlog, **When** the status and diagnostic commands report on
   it, **Then** the counts they report are the same ones they report today.

---

### User Story 4 - A hook costs the agent as little as it can (Priority: P2)

Ten to fifteen hooks fire per turn, each a fresh short-lived process. Each one
currently loads all five supported agents' code to use one of them, reads the
configuration file twice, and — on a closing turn — deep-walks and
credential-scrubs the same summary three times over and stats every file of
every recent session to find nothing expired. None of it is visible in a single
invocation; all of it is paid on every turn of every developer.

**Why this priority**: pure cost with no behavioural change, so it can ship
independently and be measured directly. Nothing about correctness depends on it.

**Independent Test**: measure hook wall time and syscall count for one closing
turn before and after; behaviour and emitted records must be byte-identical.

**Acceptance Scenarios**:

1. **Given** a hook invocation for one agent, **When** it runs, **Then** only
   that agent's code is loaded.
2. **Given** one hook invocation, **When** it resolves its effective
   configuration, **Then** the configuration file is read once.
3. **Given** a closing turn whose record is delivered directly, **When** it is
   sent, **Then** the credential scrub and capture gate are applied once, and a
   record coming out of the local backlog is still re-gated against the current
   capture settings before it is sent.
4. **Given** a machine with many recent sessions, **When** turns close
   repeatedly, **Then** expired session state is still removed, but the scan
   that finds it does not run on every close.
5. **Given** any of the above, **When** the full test suite runs, **Then** every
   existing test passes unchanged.

---

### User Story 5 - A maintainer reads only code that is doing something (Priority: P3)

Someone picks the package up to add a sixth agent, or to answer an auditor's
question about what leaves the machine. What they should not have to do is work
out which of a five-overload composition helper's callers exist (none), why
there are two identical lists of the content-capture flags, which of two copies
of the same product-record guard the queue actually uses, or why acquiring a
backend URL takes four files and an interface with one implementation whose
documented second implementation is rejected by its own first line.

**Why this priority**: it costs nothing to ship and changes no behaviour, but it
is what the "written simply, no overengineering" requirement actually asks for.
It ranks last because it is invisible to every user.

**Independent Test**: the package builds, lints and tests clean with the dead
code deleted, and no import breaks.

**Acceptance Scenarios**:

1. **Given** the package after this work, **When** it is searched for exported
   symbols with no importer, **Then** none remain outside the published entry
   points.
2. **Given** the same, **When** the two content-capture flag lists are looked
   for, **Then** there is one.
3. **Given** the same, **When** the queue's product-record guard is looked for,
   **Then** there is one, shared with the module that declares the vocabulary.
4. **Given** the same, **When** enrollment is read, **Then** it is one function
   in one file with no interface and no reference to an implementation that does
   not exist.
5. **Given** the same, **When** the compiler runs, **Then** it rejects unused
   locals and parameters, so this state is enforced rather than restored by
   review.

---

### Edge Cases

- The backend answers a delivery attempt with a rejected credential *inside* an
  otherwise accepted batch: the rejection must be recorded and reported without
  the batch being retried forever.
- The diagnostic runs on a machine with no credential configured at all: that is
  "not configured yet", not "credential rejected", and must read as the former.
- The diagnostic runs against a backend that requires no credential: an
  unauthenticated success must still read as a pass.
- Turn assembly fails on a machine that can name no developer at all (no
  configuration, no git identity): the degraded summary carries no identity, as
  today — the requirement is consistency with the healthy path, not invention.
- The backlog contains an entry written by a newer version of the package, or by
  a version that predates the current record vocabulary: the first survives with
  its unknown fields, the second is dropped rather than poisoning a batch. Both
  behaviours exist today and must not change.
- A backlog entry's due time is in the file's own name and the file is renamed on
  each failed attempt: a crash mid-rename must leave exactly one copy, never two,
  and never zero.
- Expired session state whose sweep has been throttled: state older than the
  retention window must still be removed within the window's own tolerance, so
  raw prompt text does not outlive it.
- The hook's answer is a budget refusal and the agent's pipe is under
  backpressure: the refusal must reach the agent or the turn must proceed —
  never a truncated protocol message.

## Requirements *(mandatory)*

### Functional Requirements

**Diagnosability of an installation** (Story 1)

- **FR-001**: The diagnostic MUST identify itself to the backend with the same
  credentials a real delivery uses, so its verdict describes the configured
  install rather than an anonymous request.
- **FR-002**: The diagnostic MUST distinguish, in its verdict and its exit code,
  a backend that accepted the install's credential, one that rejected it, one
  that is unreachable, and an install with no backend configured yet.
- **FR-003**: A rejected credential MUST fail the diagnostic, not warn.
- **FR-004**: A delivery refused because the credential was rejected MUST be
  recorded in the local delivery tally, with the refusing status and the time,
  and MUST be surfaced by the status report.
- **FR-005**: A rejected credential MUST NOT cost a single queued record. The
  records stay queued unconditionally; what stops is the retrying. Concretely,
  after a 401 or 403 from the events endpoint: a block is persisted per
  (destination, credential fingerprint) — the fingerprint being the token digest
  the queue already computes for its partition name, never the token; automatic
  sends for that pair are suspended while it stands; the block is lifted only by
  a change of fingerprint or by the diagnostic proving the credential good, never
  by a timer; and no attempt is spent against a queued entry while it stands, so
  the backlog cannot be aged out by a refusal that is not its fault.

  *(Rewritten from the v1 form — "MUST continue to be retried … exactly as
  today" — which contradicted the normative decision in `review.md` §SEC3. The
  intent, do not lose records, is preserved verbatim; the mechanism, retry
  forever, was the defect.)*

- **FR-005a**: The diagnostic MUST perform its authenticated probe whether or
  not a block stands: it is the operator asking the backend a direct question,
  and must never be answered from local cached state.

**Attribution** (Story 2)

- **FR-006**: The developer identity on a degraded turn summary MUST be resolved
  by the same code path as on a healthy one.
- **FR-007**: A machine that can name no developer MUST still emit its turns,
  carrying no developer identity, as it does today.

**Bounded work on the hook path** (Stories 3 and 4)

- **FR-008**: One delivery pass MUST read and validate a number of backlog
  entries bounded by the configured drain batch size, independent of how large
  the backlog is.
- **FR-009**: The backlog MUST continue to drain oldest-first, MUST remain
  idempotent against duplicate enqueue, and MUST NOT lose an entry to a crash at
  any point in a pass.
- **FR-010**: A hook invocation MUST load only the agent it was invoked for.
- **FR-011**: A hook invocation MUST read the global configuration file once.
- **FR-012**: The credential scrub and capture gate MUST be applied once to a
  record the current invocation produced, and MUST still be re-applied to a
  record taken out of the local backlog before it is sent.
- **FR-013**: Expired per-session state MUST still be deleted within its
  retention window, without a full scan of session state on every closing turn.
- **FR-014**: Repeated reads of a growing transcript within one turn MUST NOT
  re-allocate and re-decode bytes already read in that turn.
- **FR-015**: The process MUST NOT exit before the hook's answer has been handed
  to the agent.

**Secrets and destinations** (derived from `review.md` §SEC0, §SEC1, §SEC2, §SEC4)

- **FR-023**: The sanitizer MUST scrub object *keys* as well as values: captured
  material contains keyed maps whose keys are the credential. Two keys that
  scrub to the same string MUST both survive under distinct spellings — silently
  merging them is data loss.
- **FR-024**: A sanitized or filtered copy MUST preserve an own `__proto__` key
  rather than dropping it, and MUST NOT have its own prototype retargeted by the
  content it copies.
- **FR-025**: Every backend URL in the configuration MUST be validated on every
  *load* of the file, not only on the interactive path that wrote it, and MUST be
  `https:` — or `http:` to loopback only. The rule MUST have exactly one
  definition.
- **FR-026**: A response body the hook decodes MUST be bounded, and neither the
  batch send nor the enforcement check MUST follow a redirect: both carry a
  bearer.

**Simplicity** (Story 5)

- **FR-016**: Every exported symbol MUST have at least one importer, counting the
  package's published entry points as importers; anything else MUST be deleted.
- **FR-017**: There MUST be exactly one definition of the content-capture flag
  list, one of the product-record guard, and one of the hook-command quoting
  patterns.
- **FR-018**: Enrollment MUST be one function, with no interface and no
  provision for an implementation that does not exist.
- **FR-019**: The build MUST reject unused locals and parameters.
- **FR-020**: The supported runtime floor MUST be verified by continuous
  integration, not only declared.

**Preserved behaviour** (all stories)

- **FR-021**: No change MUST alter what the package emits for a given input: the
  existing test suite MUST pass unmodified, except where a test asserts one of
  the defects named in the review.
- **FR-022**: No change MUST weaken any rule in the project constitution: a hook
  never fails the agent, a record is never dropped on a failed send, secrets are
  never transmitted, only owned entries are removed, usage is attributed exactly
  once, and the budget gate fails open.

### Key Entities

- **Installation health verdict**: what the diagnostic reports per check — a
  name, a level (pass, warn, fail) and a detail. Extended, not redefined: the
  backend check gains the ability to say *why*.
- **Delivery tally**: the persisted record of what local delivery lost and why
  — refused inside a batch, abandoned after its budget, or refused outright by a
  status. Gains credential rejections, which today fall through it.
- **Backlog entry**: one product record waiting to be delivered, with its
  attempt count, its first-queued time and its next-attempt time. Its identity
  and its idempotency are unchanged; only how cheaply a pass can find the due
  ones changes.
- **Developer identity**: the one string the platform stores for a developer,
  which both the turn summary and the budget gate must produce identically.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An administrator can distinguish all four backend states — healthy,
  credential rejected, unreachable, not configured — from one diagnostic run,
  with no access to the backend's own logs.
- **SC-002**: A healthy install produces zero warnings about its backend
  connection.
- **SC-003**: An install whose credential is rejected is detectable within one
  turn of the first refused delivery, rather than after a day of staleness or a
  week of silent expiry.
- **SC-004**: Every turn a machine records is attributed to the same developer,
  whether its assembly succeeded or degraded — measured as zero summaries
  carrying no developer identity on a machine that can name one.
- **SC-005**: The work one hook does per delivery pass is independent of the
  backlog size: with the backlog at its ceiling, entries read per pass is at most
  the drain batch size.
- **SC-006**: The records the package emits for the fixture payloads are
  unchanged, and the existing test suite passes with no test weakened.
- **SC-007**: A hook invocation's measured cost drops on a closing turn and on a
  tool-call turn alike, with no measured regression on either.
- **SC-008**: No exported symbol in the package lacks an importer, and the
  compiler enforces it for locals and parameters.
- **SC-009**: The declared minimum runtime is exercised by continuous
  integration on every change.

## Assumptions

- **The business requirements are the ones already written down**: `README.md`,
  `docs/DATA_HANDLING.md`, `docs/ARCHITECTURE.md` and the invariants in
  `AGENTS.md` are treated as the specification of what the package must do. This
  work adds no product capability; it makes what is documented true, diagnosable
  and cheap. No new feature, flag, record type or CLI command is in scope.
- **The backend contract is fixed**: the platform's routes, record schemas and
  the enforcement decision contract are not changed by this work, and no change
  here requires a backend change.
- **The five supported agents stay five**: adding a sixth is out of scope, though
  Story 5 makes it cheaper.
- **Windows remains a documented limitation**, unchanged.
- **The barrel-file convention is a decision for the maintainer, not a defect**:
  `AGENTS.md` mandates a public `index.ts` per module and nothing imports one.
  The specification does not require removing them; FR-016 counts a barrel's own
  re-export as an importer only if the barrel itself is kept. Deciding to drop
  the convention would be a separate, mechanical change.
- **`DecisionCache` write races stay unlocked**: a lost cache entry is a cache
  miss and the next hook asks again. Locking the gate would cost more than the
  miss.
- **Existing defaults are correct**: no timeout, ceiling, retry budget or
  retention window is retuned by this work.
