import { z } from 'zod';
import type { AgentWatchEvent, CanonicalEventType } from '../../events/canonical-event.js';
import { deriveEventId, sha256Hex } from '../../events/event-id.js';
import type { HookContext } from '../provider.js';
import { classifyTool, contentEvidence, extractFilePath, parseMcpToolName, toolCompleteType, toolStartType } from '../shared/tooling.js';

/**
 * Antigravity hook payloads, translated to canonical events.
 *
 * The payload is protojson of `exa.hooks_pb.HookArgs`
 * (`third_party/jetski/hooks_pb/hooks.proto`, read off the `agy` binary), and
 * it differs from every other agent we support in two ways that no amount of
 * field renaming can paper over:
 *
 * - There is no event-name field. `HookArgs` is a `common` block plus a oneof,
 *   and the event is whichever member of that oneof is set. Reading a
 *   `hookEventName` — a field that exists in no version of this schema — is
 *   how this provider previously produced `agent.other` with no session id for
 *   every hook, which the turn tracker then discarded.
 * - Identity is nested in `common`, and tool arguments are PascalCase
 *   (`TargetFile`, `CommandLine`) rather than the snake_case used elsewhere.
 *
 * The two-level execution model matters for attribution: an *execution* is one
 * agent run — the turn — and `PreInvocation`/`PostInvocation` bracket the
 * individual model calls inside it (`invocation_num`). Treating an invocation
 * as a turn boundary emits one turn summary per model call and inflates every
 * per-turn aggregate, so only `Stop` closes a turn here.
 */

const toolCallSchema = z
  .object({
    name: z.string().optional(),
    /** `google.protobuf.Struct`: an arbitrary JSON object. */
    args: z.unknown().optional()
  })
  .passthrough();

/** proto3 JSON encodes int32 as a number and int64 as a string. */
const protoInt = z.union([z.number(), z.string()]).optional();

const commonSchema = z
  .object({
    conversationId: z.string().optional(),
    workspacePaths: z.array(z.string()).optional(),
    transcriptPath: z.string().optional(),
    artifactDirectoryPath: z.string().optional(),
    executionId: z.string().optional(),
    modelName: z.string().optional(),
    isBattleMode: z.boolean().optional(),
    lastUserInput: z.string().optional()
  })
  .passthrough();

const payloadSchema = z
  .object({
    common: commonSchema.optional(),
    preToolHookArgs: z.object({ toolCall: toolCallSchema.optional(), stepIdx: protoInt }).passthrough().optional(),
    postToolHookArgs: z
      .object({ toolCall: toolCallSchema.optional(), stepIdx: protoInt, error: z.unknown().optional(), result: z.unknown().optional() })
      .passthrough()
      .optional(),
    preInvocationHookArgs: z.object({ invocationNum: protoInt, initialNumSteps: protoInt }).passthrough().optional(),
    postInvocationHookArgs: z
      .object({ invocationNum: protoInt, initialNumSteps: protoInt, modelOutput: z.string().optional(), modelThinking: z.string().optional() })
      .passthrough()
      .optional(),
    stopHookArgs: z
      .object({
        executionNum: protoInt,
        terminationReason: z.string().optional(),
        error: z.unknown().optional(),
        fullyIdle: z.boolean().optional(),
        finalModelOutput: z.string().optional()
      })
      .passthrough()
      .optional(),
    sessionStartHookArgs: z.object({}).passthrough().optional()
  })
  .passthrough();

export type AntigravityPayload = z.infer<typeof payloadSchema>;

/** oneof member -> the hook Antigravity fired, in `hooks.json` naming. */
const HOOK_EVENT_BY_ARGS = {
  preToolHookArgs: 'PreToolUse',
  postToolHookArgs: 'PostToolUse',
  preInvocationHookArgs: 'PreInvocation',
  postInvocationHookArgs: 'PostInvocation',
  stopHookArgs: 'Stop',
  sessionStartHookArgs: 'SessionStart'
} as const;

type AntigravityArgsKey = keyof typeof HOOK_EVENT_BY_ARGS;
export type AntigravityHookEvent = (typeof HOOK_EVENT_BY_ARGS)[AntigravityArgsKey];

const ARGS_KEYS = Object.keys(HOOK_EVENT_BY_ARGS) as AntigravityArgsKey[];

/**
 * Which hook this payload is. Returns undefined for anything that is not a
 * recognizable `HookArgs`, so a schema change shows up as no telemetry rather
 * than as mis-attributed telemetry.
 */
export function antigravityHookEvent(rawPayload: unknown): AntigravityHookEvent | undefined {
  const parsed = payloadSchema.safeParse(rawPayload);
  if (!parsed.success) return undefined;
  const key = ARGS_KEYS.find((candidate) => parsed.data[candidate] !== undefined);
  return key ? HOOK_EVENT_BY_ARGS[key] : undefined;
}

/**
 * Working directory for git and repo-config lookups. Antigravity reports a
 * workspace list rather than a single `cwd`; the first entry is the primary
 * workspace root.
 */
export function antigravityCwd(rawPayload: unknown): string | undefined {
  const parsed = payloadSchema.safeParse(rawPayload);
  if (!parsed.success) return undefined;
  return parsed.data.common?.workspacePaths?.[0];
}

export function parseAntigravityHookEvent(rawPayload: unknown, context: HookContext): AgentWatchEvent[] {
  const parsed = payloadSchema.safeParse(rawPayload);
  if (!parsed.success) return [];
  const payload = parsed.data;
  const hook = antigravityHookEvent(rawPayload);
  if (!hook) return [];

  const event = baseEvent(payload, hook);

  switch (hook) {
    case 'SessionStart':
      break;
    case 'PreInvocation': {
      // Antigravity has no "user prompt submitted" hook: the prompt is carried
      // on `common.lastUserInput` by every hook of the execution. The first
      // invocation of an execution is therefore where the turn's prompt is
      // recorded; later invocations are model calls inside the same turn.
      if (!isFirstInvocation(payload.preInvocationHookArgs?.invocationNum)) break;
      applyPrompt(event, payload, context);
      break;
    }
    case 'PostInvocation':
      event.metadata = {
        ...event.metadata,
        invocationNum: numeric(payload.postInvocationHookArgs?.invocationNum)
      };
      break;
    case 'PreToolUse':
    case 'PostToolUse':
      applyToolFields(event, payload, hook, context);
      break;
    case 'Stop':
      applyResponse(event, payload, context);
      break;
  }

  return [event];
}

function baseEvent(payload: AntigravityPayload, hook: AntigravityHookEvent): AgentWatchEvent {
  const common = payload.common;
  const sessionId = common?.conversationId;
  // An execution is the turn. `StopHookArgs.executionNum` numbers executions
  // within a conversation, and Stop fires once per execution.
  const turnId = common?.executionId;
  const toolCall = toolCallOf(payload, hook);
  const stepIdx = stepIdxOf(payload, hook);

  return {
    schemaVersion: '1',
    id: deriveEventId({
      provider: 'antigravity',
      providerEventType: hook,
      sessionId,
      turnId,
      toolUseId: stepIdx,
      payloadFingerprint: sha256Hex(JSON.stringify(fingerprintParts(payload, hook, toolCall?.name)))
    }),
    timestamp: new Date().toISOString(),
    event: { type: canonicalType(payload, hook), providerEventType: hook },
    agent: { provider: 'antigravity', name: 'Google Antigravity' },
    session: { id: sessionId, providerId: sessionId, turnId },
    ai: common?.modelName ? { model: common.modelName, billingMode: 'unknown' } : undefined,
    metadata: {
      provider: compact({
        transcriptPath: common?.transcriptPath,
        artifactDirectoryPath: common?.artifactDirectoryPath,
        stepIdx,
        isBattleMode: common?.isBattleMode,
        terminationReason: payload.stopHookArgs?.terminationReason,
        fullyIdle: payload.stopHookArgs?.fullyIdle
      })
    }
  };
}

function canonicalType(payload: AntigravityPayload, hook: AntigravityHookEvent): CanonicalEventType {
  switch (hook) {
    case 'SessionStart':
      return 'session.started';
    case 'Stop':
      return 'generation.completed';
    case 'PreInvocation':
      return isFirstInvocation(payload.preInvocationHookArgs?.invocationNum) ? 'prompt.submitted' : 'agent.other';
    case 'PostInvocation':
      return 'agent.other';
    case 'PreToolUse':
      return toolStartType(classifyTool(payload.preToolHookArgs?.toolCall?.name));
    case 'PostToolUse':
      return payload.postToolHookArgs?.error !== undefined ? 'tool.failed' : toolCompleteType(classifyTool(payload.postToolHookArgs?.toolCall?.name));
  }
}

/**
 * The invocation counter's base is not documented, so both 0 and 1 are treated
 * as the execution's first model call. A repeat is harmless: the prompt record
 * is keyed by the event id, which is stable for one execution and one prompt.
 */
function isFirstInvocation(invocationNum: unknown): boolean {
  const value = numeric(invocationNum);
  return value === undefined || value <= 1;
}

function applyPrompt(event: AgentWatchEvent, payload: AntigravityPayload, context: HookContext): void {
  const prompt = payload.common?.lastUserInput ?? '';
  event.metadata = { ...event.metadata, prompt: contentEvidence(prompt) };
  if (context.config.capture.prompts && prompt) {
    event.metadata = { ...event.metadata, promptText: prompt };
  }
}

function applyResponse(event: AgentWatchEvent, payload: AntigravityPayload, context: HookContext): void {
  const response = payload.stopHookArgs?.finalModelOutput ?? '';
  event.metadata = { ...event.metadata, response: response ? contentEvidence(response) : undefined };
  if (context.config.capture.responses && response) {
    event.metadata = { ...event.metadata, responseText: response };
  }
}

function applyToolFields(
  event: AgentWatchEvent,
  payload: AntigravityPayload,
  hook: 'PreToolUse' | 'PostToolUse',
  context: HookContext
): void {
  const args = hook === 'PreToolUse' ? payload.preToolHookArgs : payload.postToolHookArgs;
  const toolCall = args?.toolCall;
  const kind = classifyTool(toolCall?.name);
  const failed = hook === 'PostToolUse' && payload.postToolHookArgs?.error !== undefined;

  event.tool = {
    name: toolCall?.name,
    status: hook === 'PreToolUse' ? 'started' : failed ? 'failed' : 'completed'
  };

  const provider = (event.metadata?.['provider'] ?? {}) as Record<string, unknown>;
  if (kind === 'mcp' && toolCall?.name) {
    const { server, tool } = parseMcpToolName(toolCall.name);
    provider['mcpServer'] = server;
    provider['mcpTool'] = tool;
  }

  const toolInput = toolCall?.args;
  if (kind === 'shell' && context.config.capture.toolInput) {
    // `run_command` names its command `CommandLine`.
    const command = readString(toolInput, ['CommandLine', 'command']);
    if (command) event.metadata = { ...event.metadata, command };
  }
  const filePath = extractFilePath(toolInput);
  if (filePath && (kind === 'file-read' || kind === 'file-edit') && context.config.capture.files) {
    event.metadata = { ...event.metadata, filePath };
  }
  if (context.config.capture.toolInput && toolInput !== undefined) {
    event.metadata = { ...event.metadata, toolInput };
  }
  const result = payload.postToolHookArgs?.result;
  if (context.config.capture.toolOutput && result !== undefined) {
    event.metadata = { ...event.metadata, toolOutput: result };
  }
  if (failed) {
    event.metadata = { ...event.metadata, error: contentEvidence(JSON.stringify(payload.postToolHookArgs?.error)) };
  }

  event.metadata = { ...event.metadata, provider: compact(provider) };
}

function toolCallOf(payload: AntigravityPayload, hook: AntigravityHookEvent) {
  if (hook === 'PreToolUse') return payload.preToolHookArgs?.toolCall;
  if (hook === 'PostToolUse') return payload.postToolHookArgs?.toolCall;
  return undefined;
}

function stepIdxOf(payload: AntigravityPayload, hook: AntigravityHookEvent): string | undefined {
  const raw = hook === 'PreToolUse' ? payload.preToolHookArgs?.stepIdx : hook === 'PostToolUse' ? payload.postToolHookArgs?.stepIdx : undefined;
  const value = numeric(raw);
  return value === undefined ? undefined : String(value);
}

/**
 * What makes this event distinct from its siblings in the same turn.
 *
 * A prompt is identified by its text and nothing else: the invocation counter's
 * base is undocumented, so the first-invocation test admits both 0 and 1, and
 * including the counter here would give the same prompt two ids and append it
 * to the turn twice. Every other event stays keyed by its own counter, which is
 * what keeps successive invocations and tool calls apart.
 */
function fingerprintParts(payload: AntigravityPayload, hook: AntigravityHookEvent, toolName: string | undefined): unknown[] {
  if (hook === 'PreInvocation' && isFirstInvocation(payload.preInvocationHookArgs?.invocationNum)) {
    return ['prompt', payload.common?.lastUserInput ?? ''];
  }
  return [payload.common?.modelName, toolName, invocationOf(payload, hook)];
}

function invocationOf(payload: AntigravityPayload, hook: AntigravityHookEvent): number | undefined {
  if (hook === 'PreInvocation') return numeric(payload.preInvocationHookArgs?.invocationNum);
  if (hook === 'PostInvocation') return numeric(payload.postInvocationHookArgs?.invocationNum);
  return undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readString(value: unknown, keys: string[]): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
