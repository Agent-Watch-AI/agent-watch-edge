import type { AgentWatchEvent, CanonicalEventType, EventPatch } from '../../events/types/events.types.js';
import { sha256Hex } from '../../events/event-id.js';
import { baseEvent, promptPatch, responsePatch, toolPatch, withPatch } from '../shared/event-builder.js';
import { asRecord } from '../../core/object.js';
import { SHELL_COMMAND_KEY } from '../shared/constants/tooling.constants.js';
import { classifyTool, parseMcpToolName, shellCallOf, toolCompleteType, toolStartType } from '../shared/tooling.js';
import type { HookContext, ShellCall } from '../types/provider.types.js';
import {
  CODEX_DISPLAY_NAME,
  CODEX_EVENT_TYPE_MAP,
  CODEX_PROVIDER_ID,
  CODEX_SHELL_CALL_EVENTS,
  CODEX_TOOL_EVENTS,
  CODEX_UNKNOWN_EVENT
} from './constants/codex.constants.js';
import { codexPayloadSchema } from './schemas/codex.schema.js';
import type { CodexPayload } from './types/codex.types.js';

export type { CodexPayload } from './types/codex.types.js';

/**
 * Translate one Codex hook payload into canonical events.
 *
 * @param rawPayload - Raw JSON from the hook's stdin.
 * @param context - Environment and effective config.
 * @returns The canonical events, or an empty list for an unusable payload.
 */
export function parseCodexHookEvent(rawPayload: unknown, context: HookContext): AgentWatchEvent[] {
  const parsed = codexPayloadSchema.safeParse(rawPayload);

  if (!parsed.success) return [];

  const payload = parsed.data;
  const providerEventType = payload.hook_event_name ?? CODEX_UNKNOWN_EVENT;

  return [withPatch(codexBaseEvent(payload, providerEventType), hookPatch(payload, providerEventType, context))];
}

/**
 * The command a shell call runs, on its `PreToolUse` and its `PostToolUse` —
 * the latter because a command can create the worktree it works in.
 *
 * Codex reports every shell call to hooks as `Bash` with `tool_input:
 * {command}` (openai/codex `core/src/tools/hook_names.rs`,
 * `handlers/unified_exec/exec_command.rs`, 2026-09). The model's own `workdir`
 * argument is dropped before the hook, so there is no working directory to
 * read: the call runs in the payload's `cwd` unless its command says otherwise.
 *
 * @param rawPayload - Raw JSON from the hook's stdin.
 * @returns The command, or undefined for any other payload.
 */
export function codexShellCall(rawPayload: unknown): ShellCall | undefined {
  const parsed = codexPayloadSchema.safeParse(rawPayload);

  if (!parsed.success || !CODEX_SHELL_CALL_EVENTS.has(parsed.data.hook_event_name ?? '') || classifyTool(parsed.data.tool_name) !== 'shell') return undefined;

  return shellCallOf(asRecord(parsed.data.tool_input)?.[SHELL_COMMAND_KEY], undefined);
}

/**
 * The provider-independent part of the event.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Codex's own name for this hook.
 * @returns The base event.
 */
function codexBaseEvent(payload: CodexPayload, providerEventType: string): AgentWatchEvent {
  // Codex has called the same value both `session_id` and `thread_id` across
  // releases; either is the session as far as correlation is concerned.
  const sessionId = payload.session_id ?? payload.thread_id;

  return baseEvent({
    provider: CODEX_PROVIDER_ID,
    displayName: CODEX_DISPLAY_NAME,
    providerEventType,
    eventType: canonicalType(payload, providerEventType),
    sessionId,
    turnId: payload.turn_id,
    agentId: payload.agent_id,
    toolUseId: payload.tool_use_id,
    payloadFingerprint: sha256Hex(JSON.stringify(payload)),
    ai: payload.model ? { model: payload.model, billingMode: 'unknown' } : undefined,
    providerMetadata: {
      permissionMode: payload.permission_mode,
      agentType: payload.agent_type,
      toolUseId: payload.tool_use_id
    },
    timestamp: new Date().toISOString()
  });
}

/**
 * What this particular hook contributes on top of the base event.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Codex's own name for this hook.
 * @param context - Environment and effective config.
 * @returns The patch; empty for a hook we model but read nothing from.
 */
function hookPatch(payload: CodexPayload, providerEventType: string, context: HookContext): EventPatch {
  const capture = context.config.capture;

  if (providerEventType === 'SessionStart') return { metadata: { sessionSource: payload.source } };

  if (providerEventType === 'SessionEnd') return { metadata: { sessionEndReason: payload.reason } };

  if (providerEventType === 'UserPromptSubmit') return promptPatch(payload.prompt ?? '', capture);

  if (CODEX_TOOL_EVENTS.has(providerEventType)) {
    const kind = classifyTool(payload.tool_name);
    const mcp = kind === 'mcp' && payload.tool_name ? parseMcpToolName(payload.tool_name) : undefined;

    return toolPatch(
      {
        name: payload.tool_name,
        status: providerEventType === 'PostToolUse' ? 'completed' : 'started',
        kind,
        toolUseId: payload.tool_use_id,
        input: payload.tool_input,
        output: payload.tool_response,
        providerFields: mcp ? { mcpServer: mcp.server, mcpTool: mcp.tool } : undefined
      },
      capture
    );
  }

  if (providerEventType === 'Stop') {
    const response = responsePatch(payload.last_assistant_message ?? '');

    return { ...response, metadata: { stopHookActive: payload.stop_hook_active, ...response.metadata } };
  }

  if (providerEventType === 'SubagentStart' || providerEventType === 'SubagentStop') {
    return { metadata: { agentType: payload.agent_type } };
  }

  if (providerEventType === 'PreCompact' || providerEventType === 'PostCompact') {
    return { metadata: { trigger: payload.trigger } };
  }

  return {};
}

/**
 * Canonical type for a hook, falling back to the tool classification.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Codex's own name for this hook.
 * @returns The canonical event type.
 */
function canonicalType(payload: CodexPayload, providerEventType: string): CanonicalEventType {
  const direct = CODEX_EVENT_TYPE_MAP[providerEventType];

  if (direct) return direct;

  const kind = classifyTool(payload.tool_name);

  if (providerEventType === 'PreToolUse') return toolStartType(kind);

  if (providerEventType === 'PostToolUse') return toolCompleteType(kind);

  return 'agent.other';
}
