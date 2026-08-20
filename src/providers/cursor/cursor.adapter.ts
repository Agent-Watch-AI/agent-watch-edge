import { asRecord, compact } from '../../core/object.js';
import type { UnknownRecord } from '../../core/types/core.types.js';
import type { AgentWatchEvent, CanonicalEventType, EventPatch } from '../../events/types/events.types.js';
import { sha256Hex } from '../../events/event-id.js';
import { baseEvent, filePathPatch, promptPatch, responsePatch, toolPatch, withPatch } from '../shared/event-builder.js';
import { classifyTool, contentEvidence, parseMcpToolName, toolCompleteType, toolStartType } from '../shared/tooling.js';
import type { HookContext, ToolKind, ToolStatus } from '../types/provider.types.js';
import {
  ATTACHMENT_FILE_PATH_KEY,
  CURSOR_DEDICATED_COMPLETION_KINDS,
  CURSOR_DISPLAY_NAME,
  CURSOR_EDIT_TOOL_NAME,
  CURSOR_EVENT_TYPE_MAP,
  CURSOR_PROVIDER_ID,
  CURSOR_READ_TOOL_NAME,
  CURSOR_SHELL_TOOL_NAME,
  CURSOR_TOOL_KINDS,
  CURSOR_UNKNOWN_EVENT
} from './constants/cursor.constants.js';
import { cursorPayloadSchema } from './schemas/cursor.schema.js';
import type { CursorPayload } from './types/cursor.types.js';

export type { CursorPayload } from './types/cursor.types.js';

/**
 * Translate one Cursor hook payload into canonical events.
 *
 * @param rawPayload - Raw JSON from the hook's stdin.
 * @param context - Environment and effective config.
 * @returns The canonical events, or an empty list for an unusable payload.
 */
export function parseCursorHookEvent(rawPayload: unknown, context: HookContext): AgentWatchEvent[] {
  const parsed = cursorPayloadSchema.safeParse(rawPayload);

  if (!parsed.success) return [];

  const payload = parsed.data;
  const providerEventType = payload.hook_event_name ?? CURSOR_UNKNOWN_EVENT;

  return [withPatch(cursorBaseEvent(payload, providerEventType), hookPatch(payload, providerEventType, context))];
}

/**
 * The provider-independent part of the event.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Cursor's own name for this hook.
 * @returns The base event.
 */
function cursorBaseEvent(payload: CursorPayload, providerEventType: string): AgentWatchEvent {
  const sessionId = payload.conversation_id ?? payload.session_id;
  // model_id is the structured identifier and supersedes the legacy slug.
  const model = (typeof payload.model_id === 'string' && payload.model_id.length > 0 ? payload.model_id : undefined) ?? payload.model;

  return baseEvent({
    provider: CURSOR_PROVIDER_ID,
    displayName: CURSOR_DISPLAY_NAME,
    providerEventType,
    eventType: canonicalType(payload, providerEventType),
    sessionId,
    // generation_id changes per user message and matches the transcript scope —
    // it is the turn correlation key, like Claude's prompt_id.
    turnId: payload.generation_id,
    toolUseId: payload.tool_use_id,
    // Hash only: it disambiguates otherwise-identical events within a turn
    // without any content reaching the id.
    payloadFingerprint: sha256Hex(JSON.stringify(payload)),
    ai: model ? { model } : undefined,
    providerMetadata: {
      generationId: payload.generation_id,
      cursorVersion: payload.cursor_version,
      // Structured inference parameters (thinking/context/effort selections).
      modelParams: modelParams(payload)
    },
    timestamp: new Date().toISOString()
  });
}

/**
 * What this particular hook contributes on top of the base event.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Cursor's own name for this hook.
 * @param context - Environment and effective config.
 * @returns The patch; empty for a hook we model but read nothing from.
 */
function hookPatch(payload: CursorPayload, providerEventType: string, context: HookContext): EventPatch {
  const capture = context.config.capture;

  if (providerEventType === 'sessionStart') {
    return { metadata: { sessionSource: payload.composer_mode, isBackgroundAgent: payload.is_background_agent } };
  }

  if (providerEventType === 'sessionEnd') return { metadata: { sessionEndReason: payload.reason } };

  if (providerEventType === 'beforeSubmitPrompt') return submitPromptPatch(payload, context);

  if (providerEventType === 'preToolUse' || providerEventType === 'postToolUse' || providerEventType === 'postToolUseFailure') {
    return genericToolPatch(payload, providerEventType, context);
  }

  if (providerEventType === 'beforeShellExecution' || providerEventType === 'afterShellExecution') {
    return shellPatch(payload, providerEventType, context);
  }

  if (providerEventType === 'beforeMCPExecution' || providerEventType === 'afterMCPExecution') {
    return mcpPatch(payload, providerEventType, context);
  }

  if (providerEventType === 'beforeReadFile') {
    // The payload carries the full file content; only the path is ever kept.
    return {
      tool: { name: payload.tool_name ?? CURSOR_READ_TOOL_NAME, status: 'started' },
      ...filePathPatch(payload.file_path, capture)
    };
  }

  if (providerEventType === 'afterFileEdit' || providerEventType === 'afterTabFileEdit') {
    return fileEditPatch(payload, providerEventType, context);
  }

  if (providerEventType === 'subagentStart' || providerEventType === 'subagentStop') {
    return subagentPatch(payload, providerEventType);
  }

  if (providerEventType === 'preCompact') {
    return { metadata: { compactionTrigger: payload.trigger, contextUsagePercent: payload.context_usage_percent } };
  }

  if (providerEventType === 'afterAgentResponse') return responsePatch(payload.text ?? '', capture);

  if (providerEventType === 'stop') return { metadata: { stopStatus: payload.status } };

  return {};
}

/**
 * Prompt fields, including its attachments.
 *
 * @param payload - Parsed hook payload.
 * @param context - Environment and effective config.
 * @returns The patch.
 */
function submitPromptPatch(payload: CursorPayload, context: HookContext): EventPatch {
  const capture = context.config.capture;
  const patch = promptPatch(payload.prompt ?? '', capture);
  const attachments = payload.attachments ?? [];

  if (attachments.length === 0) return patch;

  // Attachment paths are a per-file signal, gated like every other one.
  const paths = capture.files ? attachmentPaths(attachments) : [];

  return {
    metadata: compact({
      ...patch.metadata,
      attachmentCount: attachments.length,
      attachments: paths.length > 0 ? paths : undefined
    })
  };
}

/**
 * Tool fields for Cursor's generic tool hooks.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Cursor's own name for this hook.
 * @param context - Environment and effective config.
 * @returns The patch.
 */
function genericToolPatch(payload: CursorPayload, providerEventType: string, context: HookContext): EventPatch {
  const patch = toolPatch(
    {
      name: payload.tool_name,
      status: genericToolStatus(providerEventType),
      kind: cursorToolKind(payload.tool_name),
      durationMs: payload.duration,
      toolUseId: payload.tool_use_id,
      input: payload.tool_input,
      output: payload.tool_output
    },
    context.config.capture
  );

  if (providerEventType !== 'postToolUseFailure' || payload.error_message === undefined) return patch;

  return {
    ...patch,
    metadata: { ...patch.metadata, error: contentEvidence(payload.error_message), failureType: payload.failure_type }
  };
}

/**
 * Shell fields for Cursor's dedicated shell hooks, which report the command
 * and output at the top level rather than inside a tool-input object.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Cursor's own name for this hook.
 * @param context - Environment and effective config.
 * @returns The patch.
 */
function shellPatch(payload: CursorPayload, providerEventType: string, context: HookContext): EventPatch {
  const capture = context.config.capture;
  const completed = providerEventType === 'afterShellExecution';

  return {
    tool: { name: CURSOR_SHELL_TOOL_NAME, status: completed ? 'completed' : 'started', durationMs: payload.duration },
    metadata: compact({
      command: capture.toolInput && typeof payload.command === 'string' ? payload.command : undefined,
      toolOutput: capture.toolOutput && completed && typeof payload.output === 'string' ? payload.output : undefined
    })
  };
}

/**
 * MCP fields for Cursor's dedicated MCP hooks.
 *
 * Cursor reports the MCP *endpoint* — a url for remote servers, a command for
 * stdio ones — rather than an `mcp__server__tool` name, so the server is taken
 * from whichever of those is present.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Cursor's own name for this hook.
 * @param context - Environment and effective config.
 * @returns The patch.
 */
function mcpPatch(payload: CursorPayload, providerEventType: string, context: HookContext): EventPatch {
  const capture = context.config.capture;
  const parsed = payload.tool_name ? parseMcpToolName(payload.tool_name) : {};

  return {
    tool: {
      name: payload.tool_name,
      status: providerEventType === 'beforeMCPExecution' ? 'started' : 'completed',
      durationMs: payload.duration
    },
    metadata: compact({
      toolInput: capture.toolInput && payload.tool_input !== undefined ? payload.tool_input : undefined,
      toolOutput: capture.toolOutput && payload.result_json !== undefined ? payload.result_json : undefined,
      provider: compact({
        mcpServer: parsed.server ?? payload.url ?? payload.command,
        mcpTool: parsed.tool ?? payload.tool_name
      })
    })
  };
}

/**
 * File-edit fields for Cursor's dedicated edit hooks.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Cursor's own name for this hook.
 * @param context - Environment and effective config.
 * @returns The patch.
 */
function fileEditPatch(payload: CursorPayload, providerEventType: string, context: HookContext): EventPatch {
  const capture = context.config.capture;
  const pathPatch = filePathPatch(payload.file_path, capture);

  return {
    tool: { name: payload.tool_name ?? CURSOR_EDIT_TOOL_NAME, status: 'completed' },
    metadata: compact({
      ...pathPatch.metadata,
      // Tab edits are the editor's inline completion, not an agent tool call.
      tab: providerEventType === 'afterTabFileEdit' ? true : undefined,
      toolOutput: capture.toolOutput && payload.edits !== undefined ? payload.edits : undefined
    })
  };
}

/**
 * Subagent fields, including the child's own model and outcome.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Cursor's own name for this hook.
 * @returns The patch.
 */
function subagentPatch(payload: CursorPayload, providerEventType: string): EventPatch {
  const stopped = providerEventType === 'subagentStop';

  return {
    session: { agentId: payload.subagent_id },
    ai: !stopped && payload.subagent_model ? { model: payload.subagent_model } : undefined,
    metadata: compact({
      agentType: payload.subagent_type,
      subagentStatus: stopped ? payload.status : undefined,
      durationMs: stopped ? payload.duration_ms : undefined
    })
  };
}

/**
 * Whether a generic tool hook reports a start, a failure, or a completion.
 *
 * @param providerEventType - Cursor's own name for this hook.
 * @returns The tool status.
 */
function genericToolStatus(providerEventType: string): ToolStatus {
  if (providerEventType === 'preToolUse') return 'started';

  if (providerEventType === 'postToolUseFailure') return 'failed';

  return 'completed';
}

/**
 * File paths named by prompt attachments.
 *
 * Anything that is not a well-formed attachment is dropped rather than crashed
 * on: the field is untrusted and its shape is not documented.
 *
 * @param attachments - Raw attachment list.
 * @returns The paths, in order.
 */
function attachmentPaths(attachments: readonly unknown[]): string[] {
  const paths: string[] = [];

  for (const attachment of attachments) {
    const filePath = asRecord(attachment)?.[ATTACHMENT_FILE_PATH_KEY];

    if (typeof filePath === 'string' && filePath.length > 0) paths.push(filePath);
  }

  return paths;
}

/**
 * Structured inference parameters as a keyed record.
 *
 * Keeps only well-formed `{id, value}` entries; anything else is dropped, not
 * crashed on.
 *
 * @param payload - Parsed hook payload.
 * @returns The parameters, or undefined when there are none.
 */
function modelParams(payload: CursorPayload): UnknownRecord | undefined {
  if (!Array.isArray(payload.model_params)) return undefined;

  const params: UnknownRecord = {};

  for (const entry of payload.model_params) {
    const record = asRecord(entry);
    const id = record?.['id'];

    if (typeof id !== 'string' || id.length === 0) continue;

    params[id] = record?.['value'];
  }

  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * Cursor's generic tool names on top of the shared vocabularies.
 *
 * @param toolName - Provider-reported tool name.
 * @returns The kind.
 */
function cursorToolKind(toolName: string | undefined): ToolKind {
  if (toolName && CURSOR_TOOL_KINDS[toolName]) return CURSOR_TOOL_KINDS[toolName]!;

  return classifyTool(toolName);
}

/**
 * Canonical type for a hook, falling back to the tool classification.
 *
 * @param payload - Parsed hook payload.
 * @param providerEventType - Cursor's own name for this hook.
 * @returns The canonical event type.
 */
function canonicalType(payload: CursorPayload, providerEventType: string): CanonicalEventType {
  const direct = CURSOR_EVENT_TYPE_MAP[providerEventType];

  if (direct) return direct;

  const kind = cursorToolKind(payload.tool_name);

  if (providerEventType === 'preToolUse') return toolStartType(kind);

  if (providerEventType === 'postToolUse') {
    // Kinds with a dedicated completion hook complete there; mapping the
    // generic duplicate too would count the call twice.
    return CURSOR_DEDICATED_COMPLETION_KINDS.has(kind) ? 'agent.other' : toolCompleteType(kind);
  }

  // Dedicated hooks carry no failure signal, so failures always arrive through
  // the generic surface — no duplication risk here.
  if (providerEventType === 'postToolUseFailure') return 'tool.failed';

  return 'agent.other';
}
