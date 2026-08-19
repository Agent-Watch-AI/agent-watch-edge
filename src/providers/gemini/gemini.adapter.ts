import { z } from 'zod';
import type { AgentWatchEvent, CanonicalEventType } from '../../events/canonical-event.js';
import { deriveEventId, sha256Hex } from '../../events/event-id.js';
import type { HookContext } from '../provider.js';
import { classifyTool, contentEvidence, extractFilePath, parseMcpToolName, toolCompleteType, toolStartType } from '../shared/tooling.js';

const geminiPayloadSchema = z
  .object({
    hook_event_name: z.string().optional(),
    session_id: z.string().optional(),
    thread_id: z.string().optional(),
    turn_id: z.string().optional(),
    prompt_id: z.string().optional(),
    transcript_path: z.string().optional(),
    cwd: z.string().optional(),
    permission_mode: z.string().optional(),
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
    tool_name: z.string().optional(),
    tool_use_id: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    tool_error: z.unknown().optional(),
    prompt: z.string().optional(),
    prompt_response: z.string().optional(),
    source: z.string().optional(),
    model: z.string().optional(),
    reason: z.string().optional(),
    last_assistant_message: z.string().nullable().optional(),
    stop_hook_active: z.boolean().optional(),
    denialReason: z.string().optional()
  })
  .passthrough();

export type GeminiPayload = z.infer<typeof geminiPayloadSchema>;

const EVENT_TYPE_MAP: Record<string, CanonicalEventType> = {
  SessionStart: 'session.started',
  SessionEnd: 'session.ended',
  // Current Gemini CLI hook names.
  BeforeAgent: 'prompt.submitted',
  AfterAgent: 'generation.completed',
  PreCompress: 'compaction.started',
  // Kept for payload compatibility with old installations. New hook
  // registrations use the names above.
  UserPromptSubmit: 'prompt.submitted',
  PermissionRequest: 'permission.requested',
  Stop: 'generation.completed',
  SubagentStart: 'subagent.started',
  SubagentStop: 'subagent.completed',
  PreCompact: 'compaction.started',
  PostCompact: 'compaction.completed'
};

export function parseGeminiHookEvent(rawPayload: unknown, context: HookContext): AgentWatchEvent[] {
  const parsed = geminiPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) return [];
  const payload = parsed.data;
  const providerEventType = payload.hook_event_name ?? 'unknown';

  const event = baseEvent(payload, providerEventType, context);

  switch (providerEventType) {
    case 'SessionStart':
      event.metadata = { ...event.metadata, sessionSource: payload.source };
      if (payload.model) event.ai = { ...event.ai, model: payload.model };
      break;
    case 'SessionEnd':
      event.metadata = { ...event.metadata, sessionEndReason: payload.reason };
      break;
    case 'BeforeAgent':
    case 'UserPromptSubmit': {
      const prompt = payload.prompt ?? '';
      event.metadata = { ...event.metadata, prompt: contentEvidence(prompt) };
      if (context.config.capture.prompts) {
        event.metadata = { ...event.metadata, promptText: prompt };
      }
      break;
    }
    case 'BeforeTool':
    case 'AfterTool':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionRequest':
      applyToolFields(event, payload, providerEventType, context);
      break;
    case 'AfterAgent':
    case 'Stop': {
      const response = payload.prompt_response ?? payload.last_assistant_message ?? '';
      event.metadata = {
        ...event.metadata,
        stopHookActive: payload.stop_hook_active,
        response: response ? contentEvidence(response) : undefined
      };
      if (context.config.capture.responses && response) {
        event.metadata = { ...event.metadata, responseText: response };
      }
      break;
    }
    case 'SubagentStart':
    case 'SubagentStop':
      event.session.agentId = payload.agent_id;
      event.metadata = { ...event.metadata, agentType: payload.agent_type };
      break;
    default:
      break;
  }

  return [event];
}

function baseEvent(payload: GeminiPayload, providerEventType: string, _context: HookContext): AgentWatchEvent {
  const eventType = canonicalType(payload, providerEventType);
  const sessionId = payload.session_id ?? payload.thread_id;
  const turnId = payload.turn_id ?? payload.prompt_id;
  const rawFingerprint = JSON.stringify([payload.cwd, payload.model, payload.source, payload.tool_name, payload.tool_use_id]);

  return {
    schemaVersion: '1',
    id: deriveEventId({
      provider: 'gemini',
      providerEventType,
      sessionId,
      turnId,
      toolUseId: payload.tool_use_id,
      payloadFingerprint: sha256Hex(rawFingerprint)
    }),
    timestamp: new Date().toISOString(),
    event: { type: eventType, providerEventType },
    agent: { provider: 'gemini', name: 'Gemini CLI' },
    session: {
      id: sessionId,
      providerId: sessionId,
      turnId,
      agentId: payload.agent_id
    },
    ai: payload.model ? { model: payload.model, billingMode: 'unknown' } : undefined,
    metadata: {
      provider: compact({
        permissionMode: payload.permission_mode,
        agentType: payload.agent_type,
        toolUseId: payload.tool_use_id,
        transcriptPath: payload.transcript_path
      })
    }
  };
}

function canonicalType(payload: GeminiPayload, providerEventType: string): CanonicalEventType {
  const direct = EVENT_TYPE_MAP[providerEventType];
  if (direct) return direct;

  const toolClassification = classifyTool(payload.tool_name);
  if (providerEventType === 'BeforeTool' || providerEventType === 'PreToolUse') {
    return toolStartType(toolClassification);
  }
  if (providerEventType === 'AfterTool' || providerEventType === 'PostToolUse' || providerEventType === 'PostToolUseFailure') {
    return toolCompleteType(toolClassification);
  }
  return 'agent.other';
}

function applyToolFields(event: AgentWatchEvent, payload: GeminiPayload, providerEventType: string, context: HookContext): void {
  const kind = classifyTool(payload.tool_name);
  const isFailure = providerEventType === 'PostToolUseFailure';
  const isStart = providerEventType === 'BeforeTool' || providerEventType === 'PreToolUse' || providerEventType === 'PermissionRequest';

  event.tool = {
    name: payload.tool_name,
    status: isStart ? 'started' : isFailure ? 'failed' : 'completed'
  };

  const provider = (event.metadata?.['provider'] ?? {}) as Record<string, unknown>;
  provider['toolUseId'] = payload.tool_use_id;

  if (kind === 'mcp' && payload.tool_name) {
    const { server, tool } = parseMcpToolName(payload.tool_name);
    provider['mcpServer'] = server;
    provider['mcpTool'] = tool;
  }
  if (kind === 'shell' && context.config.capture.toolInput) {
    const command = (payload.tool_input as Record<string, unknown> | undefined)?.['command'];
    if (typeof command === 'string') event.metadata = { ...event.metadata, command };
  }
  const filePath = extractFilePath(payload.tool_input);
  if (filePath && (kind === 'file-read' || kind === 'file-edit') && context.config.capture.files) {
    event.metadata = { ...event.metadata, filePath };
  }
  if (context.config.capture.toolInput && payload.tool_input !== undefined) {
    event.metadata = { ...event.metadata, toolInput: payload.tool_input };
  }
  if (context.config.capture.toolOutput && payload.tool_response !== undefined) {
    event.metadata = { ...event.metadata, toolOutput: payload.tool_response };
  }
  if (isFailure && payload.tool_error !== undefined) {
    event.metadata = { ...event.metadata, error: contentEvidence(JSON.stringify(payload.tool_error)) };
  }
  if (payload.denialReason) {
    provider['denialReason'] = payload.denialReason;
  }

  event.metadata = { ...event.metadata, provider: compact(provider) };
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
