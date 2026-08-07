import { z } from 'zod';
import type { AgentWatchEvent, CanonicalEventType } from '../../events/canonical-event.js';
import { deriveEventId, sha256Hex } from '../../events/event-id.js';
import type { HookContext } from '../provider.js';
import { classifyTool, contentEvidence, extractFilePath, parseMcpToolName, toolCompleteType, toolStartType } from '../shared/tooling.js';

/**
 * Claude Code hook payload (verified against code.claude.com/docs/en/hooks,
 * 2026-08). Everything optional and passthrough: payloads are untrusted and
 * new fields must never crash the agent's hook.
 */
const claudePayloadSchema = z
  .object({
    hook_event_name: z.string().optional(),
    session_id: z.string().optional(),
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
    source: z.string().optional(),
    model: z.string().optional(),
    reason: z.string().optional(),
    last_assistant_message: z.string().nullable().optional(),
    stop_hook_active: z.boolean().optional(),
    denialReason: z.string().optional()
  })
  .passthrough();

export type ClaudePayload = z.infer<typeof claudePayloadSchema>;

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

export function parseClaudeHookEvent(rawPayload: unknown, context: HookContext): AgentWatchEvent[] {
  const parsed = claudePayloadSchema.safeParse(rawPayload);
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
    case 'UserPromptSubmit': {
      const prompt = payload.prompt ?? '';
      event.metadata = { ...event.metadata, prompt: contentEvidence(prompt) };
      if (context.config.capture.prompts) {
        event.metadata = { ...event.metadata, promptText: prompt };
      }
      break;
    }
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionRequest':
      applyToolFields(event, payload, providerEventType, context);
      break;
    case 'Stop': {
      const response = payload.last_assistant_message ?? '';
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

function baseEvent(payload: ClaudePayload, providerEventType: string, _context: HookContext): AgentWatchEvent {
  const eventType = canonicalType(payload, providerEventType);
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: '1',
    id: deriveEventId({
      provider: 'claude',
      providerEventType,
      sessionId: payload.session_id,
      toolUseId: payload.tool_use_id,
      promptId: payload.prompt_id,
      // Payload fingerprint (hash only) disambiguates otherwise-identical
      // events (e.g. two Stop events in one session) without leaking content.
      payloadFingerprint: sha256Hex(JSON.stringify(payload))
    }),
    timestamp,
    event: { type: eventType, providerEventType },
    agent: { provider: 'claude', name: 'Claude Code' },
    session: {
      id: payload.session_id,
      providerId: payload.session_id,
      agentId: payload.agent_id
    },
    metadata: {
      provider: compact({
        promptId: payload.prompt_id,
        permissionMode: payload.permission_mode,
        agentType: payload.agent_type
      })
    }
  };
}

function canonicalType(payload: ClaudePayload, providerEventType: string): CanonicalEventType {
  const direct = EVENT_TYPE_MAP[providerEventType];
  if (direct) return direct;
  const kind = classifyTool(payload.tool_name);
  switch (providerEventType) {
    case 'PreToolUse':
      return toolStartType(kind);
    case 'PostToolUse':
      return toolCompleteType(kind);
    case 'PostToolUseFailure':
      return 'tool.failed';
    default:
      return 'agent.other';
  }
}

function applyToolFields(event: AgentWatchEvent, payload: ClaudePayload, providerEventType: string, context: HookContext): void {
  const kind = classifyTool(payload.tool_name);
  event.tool = {
    name: payload.tool_name,
    status: providerEventType === 'PreToolUse' || providerEventType === 'PermissionRequest' ? 'started' : providerEventType === 'PostToolUseFailure' ? 'failed' : 'completed'
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
  if (filePath && (kind === 'file-read' || kind === 'file-edit')) {
    // Absolute for now; the enrichment stage relativizes against the repo root.
    event.metadata = { ...event.metadata, filePath };
  }
  if (context.config.capture.toolInput && payload.tool_input !== undefined) {
    event.metadata = { ...event.metadata, toolInput: payload.tool_input };
  }
  if (context.config.capture.toolOutput && payload.tool_response !== undefined) {
    event.metadata = { ...event.metadata, toolOutput: payload.tool_response };
  }
  if (providerEventType === 'PostToolUseFailure' && payload.tool_error !== undefined) {
    event.metadata = { ...event.metadata, error: contentEvidence(JSON.stringify(payload.tool_error)) };
  }
  event.metadata = { ...event.metadata, provider: compact(provider) };
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
