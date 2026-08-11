# Cursor Provider Support — Design

Date: 2026-08-12
Status: approved

## Goal

Add Cursor (cursor.com AI editor) as a third `AgentProvider` alongside Claude Code and
Codex: hook installation, canonical event mapping, turn summaries, and a
forward-compatible transcript reader for token usage.

## Context and constraints (researched 2026-08-12)

- Cursor ships lifecycle hooks (GA since Cursor 1.7) configured in `hooks.json` at
  user (`~/.cursor/hooks.json`), project, enterprise, and team levels. Hooks receive a
  JSON payload on stdin and reply via stdout JSON + exit code, like Claude Code hooks.
- Every agent-hook payload carries `conversation_id` (stable per conversation),
  `generation_id` (changes per user message), `model`, `workspace_roots`,
  `user_email`, `transcript_path`, `hook_event_name`, `cursor_version`.
- **Hooks report no token usage or cost**, and Cursor has **no native OTel export**.
  The transcript JSONL currently contains only `role`/`message` with `tool_use` blocks —
  no `usage`, no timestamps, no `tool_result`, no message ids. Cursor staff confirmed
  the enrichment request is logged with no timeline.
- `cursor-agent` CLI reads the same hooks but currently emits only
  `beforeShellExecution`/`afterShellExecution` (known Cursor issue, Jan 2026).
- Cloud agents pick up project-level `.cursor/hooks.json`, but the agentwatch binary
  is not installed in their VMs — out of scope beyond a README note.

## Decisions

1. **Scope**: IDE agent (primary), `afterTabFileEdit` tab events, CLI works implicitly
   through the shared hooks.json (partial by Cursor's bug). Cloud agents: doc note only.
2. **Token usage**: defensive transcript reader. Today it yields no usage, so Cursor
   turn summaries stay `usage_status: 'pending'` — the existing degraded path. When
   Cursor adds `usage` to transcript rows, tokens appear with no code change.
3. **No `nativeTelemetry`** on the provider (the interface field is optional).

## Components

### `src/providers/cursor/` (new, mirrors the Codex provider layout)

- **`cursor.detect.ts`** — detection: `~/.cursor` exists, `cursor` / `cursor-agent` on
  PATH, `hooksJsonPath = ~/.cursor/hooks.json`, `hooksInstalled` by scanning entries
  with `isAgentWatchHookCommand`.
- **`cursor.hooks.ts`** — install/uninstall in `~/.cursor/hooks.json`. Cursor schema:
  `{ "version": 1, "hooks": { "<event>": [{ "command": string, ... }] } }` — flat
  command lists, no matcher groups. Same discipline as existing installers: merge-only,
  ownership only via `isAgentWatchHookCommand` on each entry's `command`, backup before
  write, atomic write, refuse to touch an unparseable file, preserve foreign entries,
  record state in `installState.agents['cursor']`. No trust step exists in Cursor.
  Registered events: `sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `preToolUse`,
  `postToolUse`, `postToolUseFailure`, `beforeShellExecution`, `afterShellExecution`,
  `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`,
  `subagentStart`, `subagentStop`, `preCompact`, `afterAgentResponse`, `stop`,
  `afterTabFileEdit`. NOT registered: `beforeTabFileRead` (fires on every tab
  suggestion and carries full file content — noise + privacy), `afterAgentThought`,
  `workspaceOpen`.
- **`cursor.adapter.ts`** — zod passthrough schema (unknown fields never crash the
  hook), canonical mapping:

  | Cursor event | Canonical type | Notes |
  |---|---|---|
  | `sessionStart` / `sessionEnd` | `session.started` / `session.ended` | metadata: `composer_mode`, `is_background_agent`, end `reason` |
  | `beforeSubmitPrompt` | `prompt.submitted` | prompt text gated by `capture.prompts`; evidence always |
  | `preToolUse` / `postToolUse` / `postToolUseFailure` | `tool.*` via `classifyTool` | `tool_use_id`, duration, error gated like Claude |
  | `beforeShellExecution` / `afterShellExecution` | `shell.started` / `shell.completed` | command gated by `capture.toolInput` |
  | `beforeMCPExecution` / `afterMCPExecution` | `mcp.started` / `mcp.completed` | server/tool metadata |
  | `beforeReadFile` | `file.read` | file path only (gated by `capture.files`); content is never captured |
  | `afterFileEdit` | `file.edited` | path gated by `capture.files`; edits gated by `capture.toolOutput` |
  | `subagentStart` / `subagentStop` | `subagent.started` / `subagent.completed` | `subagent_id` → agentId, `subagent_type` → agentType |
  | `preCompact` | `compaction.started` | context stats in metadata |
  | `afterAgentResponse` | `agent.other` + response turn record | text gated by `capture.responses` |
  | `stop` | `generation.completed` | closes the turn; carries `status` |
  | `afterTabFileEdit` | `file.edited` | `metadata.tab: true`; standalone (no session/turn) |

  Identity: `conversation_id` → `session.id`, `generation_id` → `session.turnId`.
  Event ids via `deriveEventId` with `tool_use_id` / `generation_id` in the identity,
  payload fingerprint like the Claude adapter.
- **`cursor.provider.ts`** — assembles `AgentProvider`; `getHookResponse` returns
  `{ exitCode: 0 }` (silence; Cursor's `before*` hooks fail open, and an absent
  `permission` field means allow — verify against a live Cursor during implementation).

### Turn-model extension: response records

Cursor's `stop` has no response text; `afterAgentResponse` does. `TurnRecord` gains a
third kind: `{ kind: 'response'; at; turnId?; text?; evidence? }`. `trackTurn` appends
it for events carrying response metadata; `closeTurnLocked` uses the turn's **last**
response record as the summary `response` when the Stop event itself has none (Claude's
Stop-supplied response keeps priority). Gated by `capture.responses`.

### `src/turns/cursor-transcript.ts` (new)

Same tail-read + retry/settle strategy as `claude-transcript.ts`. Parses JSONL rows
defensively; sums `usage`-shaped fields (`input_tokens`, `output_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`) found on rows or
`message.usage`, dedupes by message id when present (content hash otherwise), reports
the dominant model by token weight. Today Cursor rows carry none of this → returns
`undefined` → summaries stay `pending`. Rows have no timestamps today, so the reader
cannot window by time; it claims per-message exactly-once through the existing usage
ledger only when usage exists.

### Wiring changes (existing files)

- `src/providers/registry.ts` — register `cursorProvider`.
- `src/providers/provider.ts` — allow `--agent cursor` in `isAgentWatchHookCommand`.
- `src/turns/turn-summary.ts` — `PROVIDER_LABELS['cursor'] = 'cursor'`.
- `src/turns/turn-tracker.ts` — transcript-usage gate becomes a per-provider reader
  selection (`claude` → claude reader, `cursor` → cursor reader, else none); surface
  resolution: `cursor` → always `ide` in v1 (`is_background_agent` is recorded as
  metadata on `session.started` only; a distinct `cloud` surface would need the flag
  on the Stop payload, which Cursor does not provide).
- `src/billing/billing-mode.ts` — `cursor` returns `unknown` (field omitted).
- `src/cli/doctor.ts` — Cursor section: hooks installed; warning that `cursor-agent`
  CLI emits only shell events (Cursor bug); warning that token usage is unavailable
  until Cursor enriches transcripts (summaries stay `pending`).
- README + CHANGELOG entries.

## Error handling

Same philosophy as existing providers: every parse failure returns `[]` (never a
failed hook), transcript problems degrade to no usage, install refuses to modify
files it cannot parse and never deletes foreign entries, git/context enrichment is
provider-agnostic and unchanged.

## Testing

- `tests/cursor-provider.test.ts` — fixtures for each payload form; adapter mapping,
  ids stable per payload and distinct per `tool_use_id`/`generation_id`; capture-flag
  gating (prompts/responses/toolInput/toolOutput/files); malformed payloads never throw.
- Hooks install/uninstall: fresh file, merge with foreign entries, unparseable file
  refusal, idempotency, uninstall removes only ours.
- Response record: pipeline test — cursor `beforeSubmitPrompt` + `afterAgentResponse`
  + `stop` produces one `turn.summary` with the response text; Claude path unaffected.
- Cursor transcript: today-format rows → `undefined`; synthetic rows with `usage` →
  summed tokens and dominant model (forward-compat proof).
- Registry/doctor coverage in existing test files.

## Out of scope

- Cursor Admin/Teams API usage ingestion (backend concern).
- `beforeTabFileRead`, `afterAgentThought`, `workspaceOpen` hooks.
- Cloud-agent installation (README note only).
- OTel/llm.call ledger for Cursor (no source exists).
