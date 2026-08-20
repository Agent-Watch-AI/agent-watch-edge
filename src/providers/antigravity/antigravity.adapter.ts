import type { AgentWatchEvent, CanonicalEventType, EventPatch } from '../../events/types/events.types.js';
import { sha256Hex } from '../../events/event-id.js';
import { baseEvent, promptPatch, responsePatch, toolPatch, withPatch } from '../shared/event-builder.js';
import { classifyTool, parseMcpToolName, toolCompleteType, toolStartType } from '../shared/tooling.js';
import type { HookContext, ToolStatus } from '../types/provider.types.js';
import {
  ANTIGRAVITY_DISPLAY_NAME,
  ANTIGRAVITY_HOOK_EVENT_BY_ARGS,
  ANTIGRAVITY_PROVIDER_ID
} from './constants/antigravity.constants.js';
import { antigravityPayloadSchema } from './schemas/antigravity.schema.js';
import type { AntigravityArgsKey, AntigravityHookEvent, AntigravityPayload, AntigravityToolCall } from './types/antigravity.types.js';

export type { AntigravityHookEvent, AntigravityPayload } from './types/antigravity.types.js';

const ARGS_KEYS = Object.keys(ANTIGRAVITY_HOOK_EVENT_BY_ARGS) as AntigravityArgsKey[];

/**
 * Which hook this payload is.
 *
 * `HookArgs` carries no event-name field: the event is whichever member of its
 * oneof is set. Anything that is not a recognizable `HookArgs` returns
 * undefined, so a schema change shows up as no telemetry rather than as
 * mis-attributed telemetry.
 *
 * @param rawPayload - Raw JSON from the hook's stdin.
 * @returns The hook name, or undefined.
 */
export function antigravityHookEvent(rawPayload: unknown): AntigravityHookEvent | undefined {
  const parsed = antigravityPayloadSchema.safeParse(rawPayload);

  if (!parsed.success) return undefined;

  const key = ARGS_KEYS.find((candidate) => parsed.data[candidate] !== undefined);

  return key ? ANTIGRAVITY_HOOK_EVENT_BY_ARGS[key] : undefined;
}

/**
 * Working directory for git and repo-config lookups.
 *
 * Antigravity reports a workspace list rather than a single `cwd`; the first
 * entry is the primary workspace root.
 *
 * @param rawPayload - Raw JSON from the hook's stdin.
 * @returns The primary workspace path, or undefined.
 */
export function antigravityCwd(rawPayload: unknown): string | undefined {
  const parsed = antigravityPayloadSchema.safeParse(rawPayload);

  if (!parsed.success) return undefined;

  return parsed.data.common?.workspacePaths?.[0];
}

/**
 * Translate one Antigravity hook payload into canonical events.
 *
 * The two-level execution model matters for attribution: an *execution* is one
 * agent run — the turn — and PreInvocation/PostInvocation bracket the individual
 * model calls inside it. Treating an invocation as a turn boundary would emit
 * one turn summary per model call and inflate every per-turn aggregate, so only
 * `Stop` closes a turn here.
 *
 * @param rawPayload - Raw JSON from the hook's stdin.
 * @param context - Environment and effective config.
 * @returns The canonical events, or an empty list for an unusable payload.
 */
export function parseAntigravityHookEvent(rawPayload: unknown, context: HookContext): AgentWatchEvent[] {
  const parsed = antigravityPayloadSchema.safeParse(rawPayload);

  if (!parsed.success) return [];

  const payload = parsed.data;
  const hook = antigravityHookEvent(rawPayload);

  if (!hook) return [];

  return [withPatch(antigravityBaseEvent(payload, hook), hookPatch(payload, hook, context))];
}

/**
 * The provider-independent part of the event.
 *
 * @param payload - Parsed hook payload.
 * @param hook - Which hook fired.
 * @returns The base event.
 */
function antigravityBaseEvent(payload: AntigravityPayload, hook: AntigravityHookEvent): AgentWatchEvent {
  const common = payload.common;
  const stepIdx = stepIdxOf(payload, hook);

  return baseEvent({
    provider: ANTIGRAVITY_PROVIDER_ID,
    displayName: ANTIGRAVITY_DISPLAY_NAME,
    providerEventType: hook,
    eventType: canonicalType(payload, hook),
    sessionId: common?.conversationId,
    // An execution is the turn: `StopHookArgs.executionNum` numbers executions
    // within a conversation, and Stop fires once per execution.
    turnId: common?.executionId,
    toolUseId: stepIdx,
    payloadFingerprint: sha256Hex(JSON.stringify(fingerprintParts(payload, hook))),
    ai: common?.modelName ? { model: common.modelName, billingMode: 'unknown' } : undefined,
    providerMetadata: {
      transcriptPath: common?.transcriptPath,
      artifactDirectoryPath: common?.artifactDirectoryPath,
      stepIdx,
      isBattleMode: common?.isBattleMode,
      terminationReason: payload.stopHookArgs?.terminationReason,
      fullyIdle: payload.stopHookArgs?.fullyIdle
    },
    timestamp: new Date().toISOString()
  });
}

/**
 * What this particular hook contributes on top of the base event.
 *
 * @param payload - Parsed hook payload.
 * @param hook - Which hook fired.
 * @param context - Environment and effective config.
 * @returns The patch; empty for a hook we model but read nothing from.
 */
function hookPatch(payload: AntigravityPayload, hook: AntigravityHookEvent, context: HookContext): EventPatch {
  if (hook === 'PreInvocation') {
    // Antigravity has no "user prompt submitted" hook: the prompt is carried on
    // `common.lastUserInput` by every hook of the execution. The first
    // invocation is therefore where the turn's prompt is recorded; later
    // invocations are model calls inside the same turn.
    if (!isFirstInvocation(payload.preInvocationHookArgs?.invocationNum)) return {};

    return promptPatch(payload.common?.lastUserInput ?? '', context.config.capture);
  }

  if (hook === 'PostInvocation') {
    return { metadata: { invocationNum: numeric(payload.postInvocationHookArgs?.invocationNum) } };
  }

  if (hook === 'PreToolUse' || hook === 'PostToolUse') return antigravityToolPatch(payload, hook, context);

  if (hook === 'Stop') return responsePatch(payload.stopHookArgs?.finalModelOutput ?? '', context.config.capture);

  return {};
}

/**
 * Tool fields for one of Antigravity's two tool hooks.
 *
 * @param payload - Parsed hook payload.
 * @param hook - Which of the two fired.
 * @param context - Environment and effective config.
 * @returns The patch.
 */
function antigravityToolPatch(payload: AntigravityPayload, hook: 'PreToolUse' | 'PostToolUse', context: HookContext): EventPatch {
  const toolCall = toolCallOf(payload, hook);
  const kind = classifyTool(toolCall?.name);
  const failed = hook === 'PostToolUse' && payload.postToolHookArgs?.error !== undefined;
  const mcp = kind === 'mcp' && toolCall?.name ? parseMcpToolName(toolCall.name) : undefined;

  return toolPatch(
    {
      name: toolCall?.name,
      status: toolStatus(hook, failed),
      kind,
      input: toolCall?.args,
      output: hook === 'PostToolUse' ? payload.postToolHookArgs?.result : undefined,
      error: failed ? payload.postToolHookArgs?.error : undefined,
      providerFields: mcp ? { mcpServer: mcp.server, mcpTool: mcp.tool } : undefined
    },
    context.config.capture
  );
}

/**
 * Whether a tool hook reports a start, a failure, or a completion.
 *
 * @param hook - Which of the two tool hooks fired.
 * @param failed - Whether the post-tool payload carried an error.
 * @returns The tool status.
 */
function toolStatus(hook: 'PreToolUse' | 'PostToolUse', failed: boolean): ToolStatus {
  if (hook === 'PreToolUse') return 'started';

  return failed ? 'failed' : 'completed';
}

/**
 * Canonical type for a hook.
 *
 * @param payload - Parsed hook payload.
 * @param hook - Which hook fired.
 * @returns The canonical event type.
 */
function canonicalType(payload: AntigravityPayload, hook: AntigravityHookEvent): CanonicalEventType {
  if (hook === 'SessionStart') return 'session.started';

  if (hook === 'Stop') return 'generation.completed';

  if (hook === 'PreInvocation') {
    return isFirstInvocation(payload.preInvocationHookArgs?.invocationNum) ? 'prompt.submitted' : 'agent.other';
  }

  if (hook === 'PostInvocation') return 'agent.other';

  if (hook === 'PreToolUse') return toolStartType(classifyTool(payload.preToolHookArgs?.toolCall?.name));

  if (payload.postToolHookArgs?.error !== undefined) return 'tool.failed';

  return toolCompleteType(classifyTool(payload.postToolHookArgs?.toolCall?.name));
}

/**
 * Whether an invocation counter names the execution's first model call.
 *
 * The counter's base is not documented, so both 0 and 1 are treated as first. A
 * repeat is harmless: the prompt record is keyed by the event id, which is
 * stable for one execution and one prompt.
 *
 * @param invocationNum - The reported counter, in either proto3 JSON encoding.
 * @returns True when this is the first invocation.
 */
function isFirstInvocation(invocationNum: unknown): boolean {
  const value = numeric(invocationNum);

  return value === undefined || value <= 1;
}

/**
 * The tool call one of the tool hooks carries.
 *
 * @param payload - Parsed hook payload.
 * @param hook - Which hook fired.
 * @returns The call, or undefined for a non-tool hook.
 */
function toolCallOf(payload: AntigravityPayload, hook: AntigravityHookEvent): AntigravityToolCall | undefined {
  if (hook === 'PreToolUse') return payload.preToolHookArgs?.toolCall;

  if (hook === 'PostToolUse') return payload.postToolHookArgs?.toolCall;

  return undefined;
}

/**
 * The step index of a tool hook, as a string id.
 *
 * @param payload - Parsed hook payload.
 * @param hook - Which hook fired.
 * @returns The index, or undefined for a non-tool hook.
 */
function stepIdxOf(payload: AntigravityPayload, hook: AntigravityHookEvent): string | undefined {
  const value = numeric(rawStepIdx(payload, hook));

  return value === undefined ? undefined : String(value);
}

/**
 * The step index as the payload encodes it.
 *
 * @param payload - Parsed hook payload.
 * @param hook - Which hook fired.
 * @returns The raw value, or undefined for a non-tool hook.
 */
function rawStepIdx(payload: AntigravityPayload, hook: AntigravityHookEvent): unknown {
  if (hook === 'PreToolUse') return payload.preToolHookArgs?.stepIdx;

  if (hook === 'PostToolUse') return payload.postToolHookArgs?.stepIdx;

  return undefined;
}

/**
 * What makes this event distinct from its siblings in the same turn.
 *
 * A prompt is identified by its text and nothing else: the invocation counter's
 * base is undocumented, so the first-invocation test admits both 0 and 1, and
 * including the counter here would give the same prompt two ids and append it to
 * the turn twice. Every other event stays keyed by its own counter, which is
 * what keeps successive invocations and tool calls apart.
 *
 * @param payload - Parsed hook payload.
 * @param hook - Which hook fired.
 * @returns The parts to hash.
 */
function fingerprintParts(payload: AntigravityPayload, hook: AntigravityHookEvent): unknown[] {
  if (hook === 'PreInvocation' && isFirstInvocation(payload.preInvocationHookArgs?.invocationNum)) {
    return ['prompt', payload.common?.lastUserInput ?? ''];
  }

  return [payload.common?.modelName, toolCallOf(payload, hook)?.name, invocationOf(payload, hook)];
}

/**
 * The invocation counter of an invocation hook.
 *
 * @param payload - Parsed hook payload.
 * @param hook - Which hook fired.
 * @returns The counter, or undefined for other hooks.
 */
function invocationOf(payload: AntigravityPayload, hook: AntigravityHookEvent): number | undefined {
  if (hook === 'PreInvocation') return numeric(payload.preInvocationHookArgs?.invocationNum);

  if (hook === 'PostInvocation') return numeric(payload.postInvocationHookArgs?.invocationNum);

  return undefined;
}

/**
 * A proto3 JSON integer as a number, whichever encoding it arrived in.
 *
 * @param value - A number or its string form.
 * @returns The finite number, or undefined.
 */
function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;

  if (typeof value !== 'string' || value.trim() === '') return undefined;

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}
