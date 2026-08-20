import type { z } from 'zod';
import type { claudePayloadSchema } from '../schemas/claude.schema.js';

export type ClaudePayload = z.infer<typeof claudePayloadSchema>;
