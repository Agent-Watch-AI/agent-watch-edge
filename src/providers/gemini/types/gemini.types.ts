import type { z } from 'zod';
import type { geminiPayloadSchema } from '../schemas/gemini.schema.js';

export type GeminiPayload = z.infer<typeof geminiPayloadSchema>;
