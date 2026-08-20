import fs from 'node:fs/promises';
import type { JsonReadResult } from './types/storage.types.js';

export type { JsonReadResult } from './types/storage.types.js';

/**
 * Tolerant JSON read.
 *
 * A missing file is normal (nothing is installed yet); an unparseable file is
 * *reported* rather than treated as empty, because every caller's next move
 * would otherwise be to overwrite a config it could not understand.
 *
 * @param filePath - File to read.
 * @returns Missing, invalid with a reason, or the decoded value.
 */
export async function readJsonFile(filePath: string): Promise<JsonReadResult> {
  let raw: string;

  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === 'ENOENT') return { state: 'missing' };

    return { state: 'invalid', error: `unreadable: ${(error as Error).message}` };
  }

  if (raw.trim() === '') return { state: 'missing' };

  try {
    return { state: 'ok', value: JSON.parse(raw) };
  } catch (error) {
    return { state: 'invalid', error: `invalid JSON: ${(error as Error).message}` };
  }
}
