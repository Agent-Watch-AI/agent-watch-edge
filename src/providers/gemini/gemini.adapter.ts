import type { AgentWatchEvent, CanonicalEventType, EventPatch } from '../../events/types/events.types.js';
import { sha256Hex } from '../../events/event-id.js';
import { baseEvent, promptPatch, responsePatch, toolPatch, withPatch } from '../shared/event-builder.js';
import { classifyTool, parseMcpToolName, toolCompleteType, toolStartType } from '../shared/tooling.js';
import type { HookContext, ToolStatus } from '../types/provider.types.js';
import {
  GEMINI_DISPLAY_NAME,
  GEMINI_EVENT_TYPE_MAP,
  GEMINI_PROMPT_EVENTS,
  GEMINI_PROVIDER_ID,
  GEMINI_STOP_EVENTS,
  GEMINI_TOOL_COMPLETE_EVENTS,
  GEMINI_TOOL_EVENTS,
  GEMINI_TOOL_START_EVENTS,
  GEMINI_UNKNOWN_EVENT
} from './constants/gemini.constants.js';
import { geminiPayloadSchema } from './schemas/gemini.schema.js';
import type { GeminiPayload } from './types/gemini.types.js';

export type { GeminiPayload } from './types/gemini.types.js';

/**
 * Translate one Gemini CLI hook payload into canonical events.
 *
 * Both the current hook names and the ones earlier installations registered are
 * accepted: a user who has not re-run setup still sends the old shape, and
 * dropping it would silently stop their telemetry.
 *
 * @param rawPayload - Raw JSON from the hook's stdin.
 * @param context - Environment and effective config.
 * @returns The canonical events, or an empty list for an unusable payload.
 */
export function parseGeminiHookEvent(rawPayload: unknown, context: HookContext): AgentWatchEvent[] {
  const parsed = geminiPayloadSchema.safeParse(rawPayload);

  if (!parsed.success) return [];

  const payload = parsed.data;
  const providerEventType = payload.hook_event_name ?? GEMINI_UNKNOWN_EVENT;

  return [withPatch(geminiBaseEvent(payload, providerEventType), hookPatch(payload, providerEventType, context))];
}

/**
 * The provider-independent part of the event.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Gemini's own name for this hook.
 * @returns The base event.
 */
function geminiBaseEvent(payload: GeminiPayload, providerEventType: string): AgentWatchEvent {
  const sessionId = payload.session_id ?? payload.thread_id;

  return baseEvent({
    provider: GEMINI_PROVIDER_ID,
    displayName: GEMINI_DISPLAY_NAME,
    providerEventType,
    eventType: canonicalType(payload, providerEventType),
    sessionId,
    turnId: payload.turn_id ?? payload.prompt_id,
    agentId: payload.agent_id,
    toolUseId: payload.tool_use_id,
    // A narrow fingerprint on purpose: hashing the whole payload would fold the
    // prompt and response text into the id, and these fields are enough to keep
    // sibling events of one turn distinct.
    payloadFingerprint: sha256Hex(JSON.stringify([payload.cwd, payload.model, payload.source, payload.tool_name, payload.tool_use_id])),
    ai: payload.model ? { model: payload.model, billingMode: 'unknown' } : undefined,
    providerMetadata: {
      permissionMode: payload.permission_mode,
      agentType: payload.agent_type,
      toolUseId: payload.tool_use_id,
      transcriptPath: payload.transcript_path
    },
    timestamp: new Date().toISOString()
  });
}

/**
 * What this particular hook contributes on top of the base event.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Gemini's own name for this hook.
 * @param context - Environment and effective config.
 * @returns The patch; empty for a hook we model but read nothing from.
 */
function hookPatch(payload: GeminiPayload, providerEventType: string, context: HookContext): EventPatch {
  const capture = context.config.capture;

  if (providerEventType === 'SessionStart') {
    return {
      metadata: { sessionSource: payload.source },
      ai: payload.model ? { model: payload.model } : undefined
    };
  }

  if (providerEventType === 'SessionEnd') return { metadata: { sessionEndReason: payload.reason } };

  if (GEMINI_PROMPT_EVENTS.has(providerEventType)) return promptPatch(payload.prompt ?? '', capture);

  if (GEMINI_TOOL_EVENTS.has(providerEventType)) return geminiToolPatch(payload, providerEventType, context);

  if (GEMINI_STOP_EVENTS.has(providerEventType)) {
    // Gemini reports the answer as `prompt_response`; the other name is what
    // installations registered before the rename still send.
    const response = responsePatch(payload.prompt_response ?? payload.last_assistant_message ?? '', capture);

    return { ...response, metadata: { stopHookActive: payload.stop_hook_active, ...response.metadata } };
  }

  if (providerEventType === 'SubagentStart' || providerEventType === 'SubagentStop') {
    return { session: { agentId: payload.agent_id }, metadata: { agentType: payload.agent_type } };
  }

  return {};
}

/**
 * Tool fields for one of Gemini's tool hooks.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Gemini's own name for this hook.
 * @param context - Environment and effective config.
 * @returns The patch.
 */
function geminiToolPatch(payload: GeminiPayload, providerEventType: string, context: HookContext): EventPatch {
  const kind = classifyTool(payload.tool_name);
  const failed = providerEventType === 'PostToolUseFailure';
  const mcp = kind === 'mcp' && payload.tool_name ? parseMcpToolName(payload.tool_name) : undefined;

  return toolPatch(
    {
      name: payload.tool_name,
      status: toolStatus(providerEventType),
      kind,
      toolUseId: payload.tool_use_id,
      input: payload.tool_input,
      output: payload.tool_response,
      error: failed ? payload.tool_error : undefined,
      providerFields: {
        ...(mcp ? { mcpServer: mcp.server, mcpTool: mcp.tool } : {}),
        denialReason: payload.denialReason
      }
    },
    context.config.capture
  );
}

/**
 * Whether a tool hook reports a start, a failure, or a completion.
 *
 * @param providerEventType - Gemini's own name for this hook.
 * @returns The tool status.
 */
function toolStatus(providerEventType: string): ToolStatus {
  if (GEMINI_TOOL_START_EVENTS.has(providerEventType)) return 'started';

  if (providerEventType === 'PostToolUseFailure') return 'failed';

  return 'completed';
}

/**
 * Canonical type for a hook, falling back to the tool classification.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Gemini's own name for this hook.
 * @returns The canonical event type.
 */
function canonicalType(payload: GeminiPayload, providerEventType: string): CanonicalEventType {
  const direct = GEMINI_EVENT_TYPE_MAP[providerEventType];

  if (direct) return direct;

  const kind = classifyTool(payload.tool_name);

  if (GEMINI_TOOL_START_EVENTS.has(providerEventType)) return toolStartType(kind);

  if (GEMINI_TOOL_COMPLETE_EVENTS.has(providerEventType)) return toolCompleteType(kind);

  return 'agent.other';
}
