# LLM block enforcement — Edge side

Date: 2026-08-26
Status: implemented
Counterpart: `agent-watch-core/docs/superpowers/specs/2026-08-26-llm-block-enforcement-design.md`

## Problem

The platform now answers one question the Edge can ask before a turn starts:

```
GET /v1/enforcement/decision?developer_id=<external id>
Authorization: Bearer aw_edge_…

{ "decision": "allow" }
{ "decision": "block", "message": "Ivan Petrov passed his $500 hard limit and has now spent $612 this month." }
```

Nothing asks it. A policy whose action is `block` still produces only an alert.
The Edge is the one component in front of a developer's LLM calls, so it is
the one that can act — and the one that can take an entire engineering
organization offline if it acts on anything other than a clear refusal.

## The rule this whole change exists to keep

**Only an explicit `block` from the server blocks.** Everything else — every
transport failure, every other status, every body this code does not fully
understand — allows the call and says nothing to the agent.

Exhaustively, the cases that **allow**:

| Case                                              | Why it is not a refusal                                  |
| ------------------------------------------------- | -------------------------------------------------------- |
| No endpoint, or no token                           | Nothing was asked; nobody said no.                        |
| `enforcement.enabled: false`                       | The tenant's own opt-out.                                 |
| No developer identity to ask about                 | The question has no subject.                              |
| Timeout (300 ms) or network error                  | A server that cannot answer has not refused.              |
| Any non-2xx: 400, 401, 403, 404, 429, 5xx          | A misconfiguration or an outage, not a policy decision.   |
| A body that is not JSON, or not an object          | Unreadable is not "no".                                   |
| `{"decision":"allow"}`                             | The answer itself.                                        |
| A decision this code does not recognise            | Same reason the server never turns an unknown into a block.|
| `{"decision":"block"}` with no message             | A refusal a developer cannot act on is worse than none.   |
| A cache entry that fails validation                | Treated as a miss, not as an answer.                       |

The one case that **blocks**: HTTP 200 with `{"decision":"block","message":"…"}`
where `message` is a non-empty string.

This is not defensive coding for its own sake; it is invariant 4.1 of
`AGENTS.md` ("a hook never fails the coding agent") applied to a feature whose
entire purpose is, occasionally, to fail one on purpose. The failure has to come
from the platform, never from the wire.

## Where the check sits

**One check per turn, at the prompt-submit hook.** That is the last moment
before the agent makes the turn's first LLM call, and it is the only hook whose
refusal costs nothing already spent: the prompt has not been sent, no tokens
have been billed, no tool has run.

Deliberately not gated:

- **Tool hooks.** A `PreToolUse` refusal stops a tool call in the middle of a
  turn whose prompt has already been paid for, and it would ask the question
  once per tool instead of once per turn.
- **Everything after the prompt.** By then the money is spent; refusing is pure
  loss.

The check runs inside the hook flow as a stage (`enforce`), between
`parse-events` and `enrich`. It fires only when the payload produced a
`prompt.submitted` event and the provider has a refusal contract for that hook,
so no other hook pays for it.

A blocked turn records **no turn state**: the prompt never reached a model, and
a prompt record with no turn behind it would be folded into whatever turn came
next and inflate its prompt. Delivery still runs, so the offline queue drains on
a refused prompt like on any other hook.

`--dry-run` never asks and never blocks: it is a preview of what would be sent,
not a rehearsal of enforcement.

## Per-provider refusal contract

Each provider owns the shape of its own refusal, because each agent invented its
own. `getBlockResponse(payload, message)` returns the refusal for its
prompt-submit hook and `undefined` for anything else — no provider can be made
to refuse a hook whose contract we have not verified.

| Provider    | Hook                              | Response                                                     |
| ----------- | --------------------------------- | ------------------------------------------------------------ |
| Claude Code | `UserPromptSubmit`                | `{"decision":"block","reason":<message>}`                     |
| Codex       | `UserPromptSubmit`                | `{"continue":false,"stopReason":<message>,"systemMessage":<message>}` |
| Cursor      | `beforeSubmitPrompt`              | `{"continue":false,"user_message":<message>}`                  |
| Gemini CLI  | `BeforeAgent` / `UserPromptSubmit`| `{"decision":"deny","reason":<message>}`                       |
| Antigravity | —                                 | not gated                                                     |

Every one of these is the documented blocking field of that hook, and every one
of them carries the platform's sentence to the person who typed the prompt.
Codex gets two fields because `stopReason` is what its parser reads and
`systemMessage` is what the user sees.

**Antigravity is not gated, and this is a gap, not an omission.** Its
`PreInvocation` result carries no decision at all (see
`antigravity.constants.ts`), so the only hook of its that can refuse anything is
`PreToolUse` — a tool gate in the middle of a turn, which is the thing this
design rejected above. An Antigravity user over a `block` cap keeps working and
keeps producing alerts.

The exit code stays 0 in every case, refusal included. The refusal travels in
the protocol's own field, which is what makes it a decision the agent
understands rather than a crashed hook — and a non-zero exit from a telemetry
hook is exactly what invariant 4.1 forbids.

The message is also written to stderr through `warnLog`, because a prompt that
disappears with its explanation shown only in a transcript view is a support
ticket.

## Local cache

`<dataDir>/enforcement-cache.json`, one JSON object, key →
`{decision: {decision, message?}, expiresAt}` — the decision as the wire spells
it, plus the moment it stops being usable.

- **Key** is `sha256(url | token | developerId)`. Hashed rather than stored:
  the file would otherwise hold the bearer token and the developer's email
  beside a dollar figure, and none of the three is needed to read an entry back.
- **TTL 60 s**, matching the server's Redis TTL. Both answers are cached, for
  the reason the server caches both: `allow` is nearly every request, and the
  two directions of staleness cost a minute of spend and a minute of patience
  respectively.
- **Failures are never cached.** A failure is not a decision. The cost of that
  choice is bounded and known: one 300 ms timeout per turn while the platform is
  unreachable.
- **Bounded**: expired entries are pruned on every write and the file is capped
  at 16 entries (a machine has one token and, through per-repository git
  identities, a handful of developer ids at most). The file is written
  atomically at 0600, and any failure to read or write it is a miss.

Stacked with the server's own 60 s Redis TTL, a change to a policy becomes
visible to a developer in up to ~2 minutes. That is the design the counterpart
document argues for; if it proves too slow, this cache is the one to drop.

## Configuration

```json
{
  "enforcement": { "enabled": true, "timeoutMs": 300, "cacheTtlMs": 60000 },
  "enforcementUrl": "https://backend.example.com/v1/enforcement/decision"
}
```

`enforcementUrl` is derived from `endpoint` when absent, like `eventsUrl` and
`otlpUrl`. Enforcement is **on by default**: a cap a tenant marked `block` is
meant to block, and a default-off guardrail is the same notification nobody
acted on that the counterpart design set out to fix.

`enforcement` joins `delivery` and `otel` in `GLOBAL_ONLY_BLOCKS`, and
`enforcementUrl` joins the global-only keys. A committed `.agentwatch.json` that
could set `enforcement.enabled: false` — or point the check at a server that
always answers `allow` — would be a one-line, repository-wide bypass of every
budget cap in the tenant.

The identity asked about is the same string `turn.summary.developer_id` carries:
`developerEmail` from the config, else `git config user.email`. It has to be,
because that is the value the platform upserted into `evidence.developers` and
the only one a developer-scoped policy can be matched through.

## Not a security control

The check runs on the developer's machine, against a config file they own. It
can be turned off by editing that file, and the whole feature can be removed by
uninstalling the Edge. It is a guardrail for people who are not trying to get
around it, and the counterpart document says the same — nothing here should be
read as a control that survives an adversary.

## Files

```
src/enforcement/enforcement.ts                      # the fail-open orchestrator
src/enforcement/decision-client.ts                  # GET + 300 ms timeout, never throws
src/enforcement/decision-cache.ts                   # the 60 s local cache
src/enforcement/schemas/enforcement.schema.ts       # the decision validator
src/enforcement/types/enforcement.types.ts
src/enforcement/constants/enforcement.constants.ts
src/enforcement/index.ts
src/pipeline/hook-pipeline.ts                       # + the `enforce` stage
src/pipeline/types/pipeline.types.ts                # + blockMessage on the state
src/cli/hook.ts                                     # response now follows the decision
src/providers/shared/hook-refusal.ts                # the one gate test, + its constants
src/providers/types/provider.types.ts               # + getBlockResponse
src/providers/{claude,codex,cursor,gemini}/*.provider.ts  # each agent's refusal shape
src/config/{config.ts,schemas,constants,types}      # + enforcement block and URL
src/git/git-context.ts                              # developerIdentity, shared with the turn path
src/transport/headers.ts                            # the Edge's request headers, shared
src/cli/status.ts                                   # reports whether enforcement is on
example/server.mjs                                  # the route, for local testing
tests/enforcement.test.ts
```

## Testing

- **Every allow case in the table above**, each asserted through
  `resolveEnforcement`: no endpoint, no token, disabled, no developer id,
  timeout, network error, 400/401/403/404/500, non-JSON body, a body that is not
  an object, `allow`, an unrecognised decision, a block with an empty message.
- **The one block case**, end to end through `runHook` against a real local HTTP
  server, per provider: the stdout each agent's protocol requires, exit code 0,
  and no turn state written for the refused prompt.
- **A provider with no contract for the payload** (a Claude `PreToolUse`, an
  Antigravity payload) is never refused even while the server answers `block`.
- **The cache**: a second prompt asks nothing (server hit once), both answers
  are cached, an expired entry re-asks, a corrupt cache file is a miss and not a
  refusal, and a failed request leaves no entry behind.
- **The developer identity** sent is the one the turn summary carries.
