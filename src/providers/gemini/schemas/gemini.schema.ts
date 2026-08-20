import { z } from 'zod';

/**
 * Gemini CLI hook payload.
 *
 * Optional and passthrough throughout: the field names have changed across
 * releases (BeforeAgent/AfterAgent replaced UserPromptSubmit/Stop) and an
 * installation registered by an older version still sends the old shape.
 */
export const geminiPayloadSchema = z
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
