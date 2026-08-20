import type { z } from 'zod';
import type { ANTIGRAVITY_HOOK_EVENT_BY_ARGS } from '../constants/antigravity.constants.js';
import type { antigravityPayloadSchema } from '../schemas/antigravity.schema.js';

export type AntigravityPayload = z.infer<typeof antigravityPayloadSchema>;

/** Which oneof member of `HookArgs` was set. */
export type AntigravityArgsKey = keyof typeof ANTIGRAVITY_HOOK_EVENT_BY_ARGS;

/** The hook Antigravity fired, in hooks.json naming. */
export type AntigravityHookEvent = (typeof ANTIGRAVITY_HOOK_EVENT_BY_ARGS)[AntigravityArgsKey];

/** A tool call as Antigravity reports it. */
export interface AntigravityToolCall {
  readonly name?: string;
  readonly args?: unknown;
}
