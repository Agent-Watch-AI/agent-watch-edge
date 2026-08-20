import { z } from 'zod';

/**
 * Claude Code hook payload (verified against code.claude.com/docs/en/hooks,
 * 2026-08).
 *
 * Everything optional and passthrough: payloads are untrusted, and a field
 * added by a new Claude Code release must never crash the agent's hook.
 */
export const claudePayloadSchema = z
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
