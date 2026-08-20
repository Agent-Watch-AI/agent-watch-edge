import { z } from 'zod';

/**
 * Cursor hook payload (verified against cursor.com/docs/hooks, 2026-08).
 *
 * Everything optional and passthrough: payloads are untrusted and a new field
 * must never crash the agent's hook. Universal fields: conversation_id (stable
 * per conversation), generation_id (changes per user message), model,
 * workspace_roots, user_email, transcript_path.
 */
export const cursorPayloadSchema = z
  .object({
    hook_event_name: z.string().optional(),
    conversation_id: z.string().optional(),
    generation_id: z.string().optional(),
    model: z.string().optional(),
    // Structured successors of the legacy `model` slug. Their exact shapes may
    // evolve, so the types stay lenient: a change must never drop the event.
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
