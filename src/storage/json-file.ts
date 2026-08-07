import fs from 'node:fs/promises';

export type JsonReadResult =
  | { state: 'missing' }
  | { state: 'invalid'; error: string }
  | { state: 'ok'; value: unknown };

/**
 * Tolerant JSON read: a missing file is normal, an unparseable file is
 * reported (never overwritten) so we don't destroy configs we can't parse.
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
