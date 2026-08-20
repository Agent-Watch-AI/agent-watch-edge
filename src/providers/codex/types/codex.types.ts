import type { z } from 'zod';
import type { codexPayloadSchema } from '../schemas/codex.schema.js';

export type CodexPayload = z.infer<typeof codexPayloadSchema>;
