import { z } from 'zod';

/**
 * Codex hook payload (verified against openai/codex generated hook schemas,
 * 2026-08): session_id (thread UUID), turn_id, cwd, hook_event_name, model,
 * permission_mode, transcript_path; tool events add
 * tool_name/tool_use_id/tool_input/tool_response.
 *
 * Loose and passthrough: the input is untrusted.
 */
export const codexPayloadSchema = z
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
