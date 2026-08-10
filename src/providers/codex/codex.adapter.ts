import { z } from 'zod';
import type { AgentWatchEvent, CanonicalEventType } from '../../events/canonical-event.js';
import { deriveEventId, sha256Hex } from '../../events/event-id.js';
import type { HookContext } from '../provider.js';
import { classifyTool, contentEvidence, extractFilePath, toolCompleteType, toolStartType } from '../shared/tooling.js';

/**
 * Codex hook payload (verified against openai/codex generated hook schemas,
 * 2026-08): session_id (thread UUID), turn_id, cwd, hook_event_name, model,
 * permission_mode, transcript_path; tool events add tool_name/tool_use_id/
 * tool_input/tool_response. Loose and passthrough: untrusted input.
 */
const codexPayloadSchema = z
  .object({
    hook_event_name: z.string().optional(),
    session_id: z.string().optional(),
    thread_id: z.string().optional(),
    turn_id: z.string().optional(),
    cwd: z.string().optional(),
    model: z.string().optional(),
    permission_mode: z.string().optional(),
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
    tool_name: z.string().optional(),
    tool_use_id: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    prompt: z.string().optional(),
    source: z.string().optional(),
    reason: z.string().optional(),
    trigger: z.string().optional(),
    last_assistant_message: z.string().nullable().optional(),
    stop_hook_active: z.boolean().optional()
  })
  .passthrough();

export type CodexPayload = z.infer<typeof codexPayloadSchema>;

const EVENT_TYPE_MAP: Record<string, CanonicalEventType> = {
  SessionStart: 'session.started',
  SessionEnd: 'session.ended',
  UserPromptSubmit: 'prompt.submitted',
  PermissionRequest: 'permission.requested',
  Stop: 'generation.completed',
  SubagentStart: 'subagent.started',
  SubagentStop: 'subagent.completed',
  PreCompact: 'compaction.started',
  PostCompact: 'compaction.completed'
};

export function parseCodexHookEvent(rawPayload: unknown, context: HookContext): AgentWatchEvent[] {
  const parsed = codexPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) return [];
  const payload = parsed.data;
  const providerEventType = payload.hook_event_name ?? 'unknown';
  const sessionId = payload.session_id ?? payload.thread_id;

  const event: AgentWatchEvent = {
    schemaVersion: '1',
    id: deriveEventId({
      provider: 'codex',
      providerEventType,
      sessionId,
      turnId: payload.turn_id,
      toolUseId: payload.tool_use_id,
      payloadFingerprint: sha256Hex(JSON.stringify(payload))
    }),
    timestamp: new Date().toISOString(),
    event: { type: canonicalType(payload, providerEventType), providerEventType },
    agent: { provider: 'codex', name: 'OpenAI Codex' },
    session: {
      id: sessionId,
      providerId: sessionId,
      turnId: payload.turn_id,
      agentId: payload.agent_id
    },
    ai: payload.model ? { model: payload.model, billingMode: 'unknown' } : undefined,
    metadata: {
      provider: compact({
        permissionMode: payload.permission_mode,
        agentType: payload.agent_type,
        toolUseId: payload.tool_use_id
      })
    }
  };

  switch (providerEventType) {
    case 'SessionStart':
      event.metadata = { ...event.metadata, sessionSource: payload.source };
      break;
    case 'SessionEnd':
      event.metadata = { ...event.metadata, sessionEndReason: payload.reason };
      break;
    case 'UserPromptSubmit': {
      const prompt = payload.prompt ?? '';
      event.metadata = { ...event.metadata, prompt: contentEvidence(prompt) };
      if (context.config.capture.prompts) event.metadata = { ...event.metadata, promptText: prompt };
      break;
    }
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PermissionRequest': {
      const kind = classifyTool(payload.tool_name);
      event.tool = {
        name: payload.tool_name,
        status: providerEventType === 'PostToolUse' ? 'completed' : 'started'
      };
      if (kind === 'shell' && context.config.capture.toolInput) {
        const command = (payload.tool_input as Record<string, unknown> | undefined)?.['command'];
        if (command !== undefined) event.metadata = { ...event.metadata, command };
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
      break;
    }
    case 'Stop': {
      const response = payload.last_assistant_message ?? '';
      event.metadata = {
        ...event.metadata,
        stopHookActive: payload.stop_hook_active,
        response: response ? contentEvidence(response) : undefined
      };
      if (context.config.capture.responses && response) event.metadata = { ...event.metadata, responseText: response };
      break;
    }
    case 'SubagentStart':
    case 'SubagentStop':
      event.metadata = { ...event.metadata, agentType: payload.agent_type };
      break;
    case 'PreCompact':
    case 'PostCompact':
      event.metadata = { ...event.metadata, trigger: payload.trigger };
      break;
    default:
      break;
  }

  return [event];
}

function canonicalType(payload: CodexPayload, providerEventType: string): CanonicalEventType {
  const direct = EVENT_TYPE_MAP[providerEventType];
  if (direct) return direct;
  const kind = classifyTool(payload.tool_name);
  switch (providerEventType) {
    case 'PreToolUse':
      return toolStartType(kind);
    case 'PostToolUse':
      return toolCompleteType(kind);
    default:
      return 'agent.other';
  }
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
