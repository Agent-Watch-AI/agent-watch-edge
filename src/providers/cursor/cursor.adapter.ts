import { z } from 'zod';
import type { AgentWatchEvent, CanonicalEventType } from '../../events/canonical-event.js';
import { deriveEventId, sha256Hex } from '../../events/event-id.js';
import type { HookContext } from '../provider.js';
import { classifyTool, contentEvidence, extractFilePath, parseMcpToolName, toolCompleteType, toolStartType, type ToolKind } from '../shared/tooling.js';

/**
 * Cursor hook payload (verified against cursor.com/docs/hooks, 2026-08).
 * Everything optional and passthrough: payloads are untrusted and new fields
 * must never crash the agent's hook. Universal fields: conversation_id
 * (stable per conversation), generation_id (changes per user message),
 * model, workspace_roots, user_email, transcript_path.
 */
const cursorPayloadSchema = z
  .object({
    hook_event_name: z.string().optional(),
    conversation_id: z.string().optional(),
    generation_id: z.string().optional(),
    model: z.string().optional(),
    // Structured successors of the legacy `model` slug. Their exact shapes may
    // evolve; lenient types so a change never drops the whole event.
    model_id: z.unknown().optional(),
    model_params: z.array(z.unknown()).optional(),
    cursor_version: z.string().optional(),
    workspace_roots: z.array(z.string()).optional(),
    transcript_path: z.string().nullable().optional(),
    cwd: z.string().optional(),
    // sessionStart / sessionEnd
    session_id: z.string().optional(),
    is_background_agent: z.boolean().optional(),
    composer_mode: z.string().optional(),
    reason: z.string().optional(),
    // beforeSubmitPrompt
    prompt: z.string().optional(),
    attachments: z.array(z.unknown()).optional(),
    // tool hooks
    tool_name: z.string().optional(),
    tool_use_id: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_output: z.unknown().optional(),
    error_message: z.string().optional(),
    failure_type: z.string().optional(),
    duration: z.number().optional(),
    duration_ms: z.number().optional(),
    // shell / MCP hooks
    command: z.string().optional(),
    output: z.string().optional(),
    url: z.string().optional(),
    result_json: z.string().optional(),
    // file hooks
    file_path: z.string().optional(),
    edits: z.array(z.unknown()).optional(),
    // subagent hooks
    subagent_id: z.string().optional(),
    subagent_type: z.string().optional(),
    subagent_model: z.string().optional(),
    parent_conversation_id: z.string().optional(),
    task: z.string().optional(),
    status: z.string().optional(),
    // afterAgentResponse
    text: z.string().optional(),
    // preCompact
    trigger: z.string().optional(),
    context_usage_percent: z.number().optional()
  })
  .passthrough();

export type CursorPayload = z.infer<typeof cursorPayloadSchema>;

const EVENT_TYPE_MAP: Record<string, CanonicalEventType> = {
  sessionStart: 'session.started',
  sessionEnd: 'session.ended',
  beforeSubmitPrompt: 'prompt.submitted',
  beforeShellExecution: 'shell.started',
  afterShellExecution: 'shell.completed',
  beforeMCPExecution: 'mcp.started',
  afterMCPExecution: 'mcp.completed',
  beforeReadFile: 'file.read',
  afterFileEdit: 'file.edited',
  afterTabFileEdit: 'file.edited',
  subagentStart: 'subagent.started',
  subagentStop: 'subagent.completed',
  preCompact: 'compaction.started',
  afterAgentResponse: 'agent.other',
  stop: 'generation.completed'
};

export function parseCursorHookEvent(rawPayload: unknown, context: HookContext): AgentWatchEvent[] {
  const parsed = cursorPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) return [];
  const payload = parsed.data;
  const providerEventType = payload.hook_event_name ?? 'unknown';

  const event = baseEvent(payload, providerEventType);

  switch (providerEventType) {
    case 'sessionStart':
      event.metadata = { ...event.metadata, sessionSource: payload.composer_mode, isBackgroundAgent: payload.is_background_agent };
      break;
    case 'sessionEnd':
      event.metadata = { ...event.metadata, sessionEndReason: payload.reason };
      break;
    case 'beforeSubmitPrompt': {
      const prompt = payload.prompt ?? '';
      event.metadata = { ...event.metadata, prompt: contentEvidence(prompt) };
      if (context.config.capture.prompts) {
        event.metadata = { ...event.metadata, promptText: prompt };
      }
      if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
        event.metadata = { ...event.metadata, attachmentCount: payload.attachments.length };
        // Attachment file paths are a per-file signal, gated like every other.
        if (context.config.capture.files) {
          const paths = payload.attachments
            .map((attachment) => (typeof attachment === 'object' && attachment !== null ? (attachment as Record<string, unknown>)['file_path'] : undefined))
            .filter((filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0);
          if (paths.length > 0) event.metadata = { ...event.metadata, attachments: paths };
        }
      }
      break;
    }
    case 'preToolUse':
    case 'postToolUse':
    case 'postToolUseFailure':
      applyToolFields(event, payload, providerEventType, context);
      break;
    case 'beforeShellExecution':
    case 'afterShellExecution':
      applyShellFields(event, payload, providerEventType, context);
      break;
    case 'beforeMCPExecution':
    case 'afterMCPExecution':
      applyMcpFields(event, payload, providerEventType, context);
      break;
    case 'beforeReadFile':
      // The payload carries the full file content; only the path is ever kept.
      event.tool = { name: payload.tool_name ?? 'Read', status: 'started' };
      applyFilePath(event, payload.file_path, context);
      break;
    case 'afterFileEdit':
    case 'afterTabFileEdit':
      event.tool = { name: payload.tool_name ?? 'Edit', status: 'completed' };
      applyFilePath(event, payload.file_path, context);
      if (providerEventType === 'afterTabFileEdit') {
        event.metadata = { ...event.metadata, tab: true };
      }
      if (context.config.capture.toolOutput && payload.edits !== undefined) {
        event.metadata = { ...event.metadata, toolOutput: payload.edits };
      }
      break;
    case 'subagentStart':
    case 'subagentStop':
      event.session.agentId = payload.subagent_id;
      event.metadata = { ...event.metadata, agentType: payload.subagent_type };
      if (providerEventType === 'subagentStart' && payload.subagent_model) {
        event.ai = { ...event.ai, model: payload.subagent_model };
      }
      if (providerEventType === 'subagentStop') {
        event.metadata = { ...event.metadata, subagentStatus: payload.status, durationMs: payload.duration_ms };
      }
      break;
    case 'preCompact':
      event.metadata = { ...event.metadata, compactionTrigger: payload.trigger, contextUsagePercent: payload.context_usage_percent };
      break;
    case 'afterAgentResponse': {
      const response = payload.text ?? '';
      event.metadata = { ...event.metadata, response: response ? contentEvidence(response) : undefined };
      if (context.config.capture.responses && response) {
        event.metadata = { ...event.metadata, responseText: response };
      }
      break;
    }
    case 'stop':
      event.metadata = { ...event.metadata, stopStatus: payload.status };
      break;
    default:
      break;
  }

  return [event];
}

function baseEvent(payload: CursorPayload, providerEventType: string): AgentWatchEvent {
  const eventType = canonicalType(payload, providerEventType);
  const sessionId = payload.conversation_id ?? payload.session_id;
  const event: AgentWatchEvent = {
    schemaVersion: '1',
    id: deriveEventId({
      provider: 'cursor',
      providerEventType,
      sessionId,
      turnId: payload.generation_id,
      toolUseId: payload.tool_use_id,
      // Payload fingerprint (hash only) disambiguates otherwise-identical
      // events within a turn without leaking content.
      payloadFingerprint: sha256Hex(JSON.stringify(payload))
    }),
    timestamp: new Date().toISOString(),
    event: { type: eventType, providerEventType },
    agent: { provider: 'cursor', name: 'Cursor' },
    session: {
      id: sessionId,
      providerId: sessionId,
      // generation_id changes per user message and matches the transcript
      // scope — it is the turn correlation key, like Claude's prompt_id.
      turnId: payload.generation_id
    },
    metadata: {
      provider: compact({
        generationId: payload.generation_id,
        cursorVersion: payload.cursor_version,
        // Structured inference parameters (thinking/context/effort selections).
        modelParams: modelParams(payload)
      })
    }
  };
  // model_id is the structured identifier and supersedes the legacy slug.
  const model = (typeof payload.model_id === 'string' && payload.model_id.length > 0 ? payload.model_id : undefined) ?? payload.model;
  if (model) event.ai = { model };
  return event;
}

/** Keep only well-formed {id, value} entries; anything else is dropped, not crashed on. */
function modelParams(payload: CursorPayload): Record<string, unknown> | undefined {
  if (!Array.isArray(payload.model_params)) return undefined;
  const params: Record<string, unknown> = {};
  for (const entry of payload.model_params) {
    if (typeof entry !== 'object' || entry === null) continue;
    const id = (entry as Record<string, unknown>)['id'];
    if (typeof id !== 'string' || id.length === 0) continue;
    params[id] = (entry as Record<string, unknown>)['value'];
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

/** Tool kinds whose completions arrive through Cursor's dedicated hooks. */
const DEDICATED_COMPLETION_KINDS = new Set<ToolKind>(['shell', 'mcp', 'file-read', 'file-edit']);

function canonicalType(payload: CursorPayload, providerEventType: string): CanonicalEventType {
  const direct = EVENT_TYPE_MAP[providerEventType];
  if (direct) return direct;
  const kind = cursorToolKind(payload.tool_name);
  switch (providerEventType) {
    case 'preToolUse':
      return toolStartType(kind);
    case 'postToolUse':
      // Cursor fires BOTH the generic postToolUse and a dedicated hook
      // (afterShellExecution / afterMCPExecution / beforeReadFile /
      // afterFileEdit) for these kinds. The dedicated hooks are the
      // authoritative completion source; mapping the generic duplicate to a
      // completion type would count every such tool call twice in
      // tool_calls / tools_used. Only kinds with no dedicated hook (Task,
      // unknown tools) complete through the generic surface.
      return DEDICATED_COMPLETION_KINDS.has(kind) ? 'agent.other' : toolCompleteType(kind);
    case 'postToolUseFailure':
      // Dedicated hooks carry no failure signal, so failures always come
      // through the generic surface — no duplication risk.
      return 'tool.failed';
    default:
      return 'agent.other';
  }
}

/** Cursor's generic tool names ("Shell", "MCP") on top of the shared sets. */
function cursorToolKind(toolName: string | undefined): ToolKind {
  switch (toolName) {
    case 'Shell':
      return 'shell';
    case 'MCP':
      return 'mcp';
    case 'Write':
      return 'file-edit';
    default:
      return classifyTool(toolName);
  }
}

function applyToolFields(event: AgentWatchEvent, payload: CursorPayload, providerEventType: string, context: HookContext): void {
  const kind = cursorToolKind(payload.tool_name);
  event.tool = {
    name: payload.tool_name,
    status: providerEventType === 'preToolUse' ? 'started' : providerEventType === 'postToolUseFailure' ? 'failed' : 'completed',
    durationMs: payload.duration
  };
  const provider = (event.metadata?.['provider'] ?? {}) as Record<string, unknown>;
  provider['toolUseId'] = payload.tool_use_id;

  if (kind === 'shell' && context.config.capture.toolInput) {
    const command = (payload.tool_input as Record<string, unknown> | undefined)?.['command'];
    if (typeof command === 'string') event.metadata = { ...event.metadata, command };
  }
  const filePath = extractFilePath(payload.tool_input);
  if (filePath && (kind === 'file-read' || kind === 'file-edit')) {
    applyFilePath(event, filePath, context);
  }
  if (context.config.capture.toolInput && payload.tool_input !== undefined) {
    event.metadata = { ...event.metadata, toolInput: payload.tool_input };
  }
  if (context.config.capture.toolOutput && payload.tool_output !== undefined) {
    event.metadata = { ...event.metadata, toolOutput: payload.tool_output };
  }
  if (providerEventType === 'postToolUseFailure' && payload.error_message !== undefined) {
    event.metadata = { ...event.metadata, error: contentEvidence(payload.error_message), failureType: payload.failure_type };
  }
  event.metadata = { ...event.metadata, provider: compact(provider) };
}

function applyShellFields(event: AgentWatchEvent, payload: CursorPayload, providerEventType: string, context: HookContext): void {
  event.tool = { name: 'Shell', status: providerEventType === 'beforeShellExecution' ? 'started' : 'completed', durationMs: payload.duration };
  if (context.config.capture.toolInput && typeof payload.command === 'string') {
    event.metadata = { ...event.metadata, command: payload.command };
  }
  if (context.config.capture.toolOutput && providerEventType === 'afterShellExecution' && typeof payload.output === 'string') {
    event.metadata = { ...event.metadata, toolOutput: payload.output };
  }
}

function applyMcpFields(event: AgentWatchEvent, payload: CursorPayload, providerEventType: string, context: HookContext): void {
  event.tool = { name: payload.tool_name, status: providerEventType === 'beforeMCPExecution' ? 'started' : 'completed', durationMs: payload.duration };
  const provider = (event.metadata?.['provider'] ?? {}) as Record<string, unknown>;
  // Cursor gives the MCP endpoint (url for remote, command for stdio servers)
  // rather than an "mcp__server__tool" name; parse the latter when it appears.
  const { server, tool } = payload.tool_name ? parseMcpToolName(payload.tool_name) : {};
  provider['mcpServer'] = server ?? payload.url ?? payload.command;
  provider['mcpTool'] = tool ?? payload.tool_name;
  if (context.config.capture.toolInput && payload.tool_input !== undefined) {
    event.metadata = { ...event.metadata, toolInput: payload.tool_input };
  }
  if (context.config.capture.toolOutput && payload.result_json !== undefined) {
    event.metadata = { ...event.metadata, toolOutput: payload.result_json };
  }
  event.metadata = { ...event.metadata, provider: compact(provider) };
}

function applyFilePath(event: AgentWatchEvent, filePath: string | undefined, context: HookContext): void {
  // capture.files gates every per-file signal, not just Git changedFiles.
  if (typeof filePath === 'string' && filePath.length > 0 && context.config.capture.files) {
    // Absolute for now; the enrichment stage relativizes against the repo root.
    event.metadata = { ...event.metadata, filePath };
  }
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
