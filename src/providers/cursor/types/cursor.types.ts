import type { z } from 'zod';
import type { cursorPayloadSchema } from '../schemas/cursor.schema.js';

export type CursorPayload = z.infer<typeof cursorPayloadSchema>;
