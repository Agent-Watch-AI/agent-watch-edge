import type { AgentWatchEvent, CanonicalEventType, EventPatch } from '../../events/types/events.types.js';
import { sha256Hex } from '../../events/event-id.js';
import { baseEvent, promptPatch, responsePatch, toolPatch, withPatch } from '../shared/event-builder.js';
import { classifyTool, parseMcpToolName, toolCompleteType, toolStartType } from '../shared/tooling.js';
import type { HookContext, ToolStatus } from '../types/provider.types.js';
import {
  CLAUDE_DISPLAY_NAME,
  CLAUDE_EVENT_TYPE_MAP,
  CLAUDE_PROVIDER_ID,
  CLAUDE_TOOL_EVENTS,
  CLAUDE_TOOL_START_EVENTS,
  CLAUDE_UNKNOWN_EVENT
} from './constants/claude.constants.js';
import { claudePayloadSchema } from './schemas/claude.schema.js';
import type { ClaudePayload } from './types/claude.types.js';

export type { ClaudePayload } from './types/claude.types.js';

/**
 * Translate one Claude Code hook payload into canonical events.
 *
 * An unrecognizable payload yields no events rather than an error: the hook has
 * to answer the agent either way, and a Claude Code release that changes its
 * schema must cost telemetry, not the developer's session.
 *
 * @param rawPayload - Raw JSON from the hook's stdin.
 * @param context - Environment and effective config.
 * @returns The canonical events, or an empty list.
 */
export function parseClaudeHookEvent(rawPayload: unknown, context: HookContext): AgentWatchEvent[] {
  const parsed = claudePayloadSchema.safeParse(rawPayload);

  if (!parsed.success) return [];

  const payload = parsed.data;
  const providerEventType = payload.hook_event_name ?? CLAUDE_UNKNOWN_EVENT;

  return [withPatch(claudeBaseEvent(payload, providerEventType), hookPatch(payload, providerEventType, context))];
}

/**
 * The provider-independent part of the event.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Claude's own name for this hook.
 * @returns The base event.
 */
function claudeBaseEvent(payload: ClaudePayload, providerEventType: string): AgentWatchEvent {
  return baseEvent({
    provider: CLAUDE_PROVIDER_ID,
    displayName: CLAUDE_DISPLAY_NAME,
    providerEventType,
    eventType: canonicalType(payload, providerEventType),
    sessionId: payload.session_id,
    // prompt_id groups every event of one prompt→response turn and matches
    // OTel prompt.id, which is what makes cost joins possible downstream.
    turnId: payload.prompt_id,
    agentId: payload.agent_id,
    toolUseId: payload.tool_use_id,
    promptId: payload.prompt_id,
    // Hash only: it disambiguates otherwise-identical events (two Stops in one
    // session) without any content reaching the id.
    payloadFingerprint: sha256Hex(JSON.stringify(payload)),
    providerMetadata: {
      promptId: payload.prompt_id,
      permissionMode: payload.permission_mode,
      agentType: payload.agent_type
    },
    timestamp: new Date().toISOString()
  });
}

/**
 * What this particular hook contributes on top of the base event.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Claude's own name for this hook.
 * @param context - Environment and effective config.
 * @returns The patch; empty for a hook we model but read nothing from.
 */
function hookPatch(payload: ClaudePayload, providerEventType: string, context: HookContext): EventPatch {
  const capture = context.config.capture;

  if (providerEventType === 'SessionStart') {
    return {
      metadata: { sessionSource: payload.source },
      ai: payload.model ? { model: payload.model } : undefined
    };
  }

  if (providerEventType === 'SessionEnd') return { metadata: { sessionEndReason: payload.reason } };

  if (providerEventType === 'UserPromptSubmit') return promptPatch(payload.prompt ?? '', capture);

  if (CLAUDE_TOOL_EVENTS.has(providerEventType)) return claudeToolPatch(payload, providerEventType, context);

  if (providerEventType === 'Stop') {
    const response = responsePatch(payload.last_assistant_message ?? '', capture);

    return { ...response, metadata: { stopHookActive: payload.stop_hook_active, ...response.metadata } };
  }

  if (providerEventType === 'SubagentStart' || providerEventType === 'SubagentStop') {
    return { session: { agentId: payload.agent_id }, metadata: { agentType: payload.agent_type } };
  }

  return {};
}

/**
 * Tool fields for one of Claude's four tool hooks.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Claude's own name for this hook.
 * @param context - Environment and effective config.
 * @returns The patch.
 */
function claudeToolPatch(payload: ClaudePayload, providerEventType: string, context: HookContext): EventPatch {
  const kind = classifyTool(payload.tool_name);
  const mcp = kind === 'mcp' && payload.tool_name ? parseMcpToolName(payload.tool_name) : undefined;

  return toolPatch(
    {
      name: payload.tool_name,
      status: toolStatus(providerEventType),
      kind,
      toolUseId: payload.tool_use_id,
      input: payload.tool_input,
      output: payload.tool_response,
      error: providerEventType === 'PostToolUseFailure' ? payload.tool_error : undefined,
      providerFields: mcp ? { mcpServer: mcp.server, mcpTool: mcp.tool } : undefined
    },
    context.config.capture
  );
}

/**
 * Whether a tool hook reports a start, a failure, or a completion.
 *
 * @param providerEventType - Claude's own name for this hook.
 * @returns The tool status.
 */
function toolStatus(providerEventType: string): ToolStatus {
  if (CLAUDE_TOOL_START_EVENTS.has(providerEventType)) return 'started';

  if (providerEventType === 'PostToolUseFailure') return 'failed';

  return 'completed';
}

/**
 * Canonical type for a hook, falling back to the tool classification.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Claude's own name for this hook.
 * @returns The canonical event type.
 */
function canonicalType(payload: ClaudePayload, providerEventType: string): CanonicalEventType {
  const direct = CLAUDE_EVENT_TYPE_MAP[providerEventType];

  if (direct) return direct;

  const kind = classifyTool(payload.tool_name);

  if (providerEventType === 'PreToolUse') return toolStartType(kind);

  if (providerEventType === 'PostToolUse') return toolCompleteType(kind);

  if (providerEventType === 'PostToolUseFailure') return 'tool.failed';

  return 'agent.other';
}
