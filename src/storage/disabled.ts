import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentWatchPaths } from './types/storage.types.js';

/**
 * Resolve the local stop marker independently of configuration validity.
 * @param paths - User data paths.
 * @returns The marker path.
 */
export function disabledFile(paths: AgentWatchPaths): string {
  return path.join(paths.dataDir, 'disabled.json');
}

/**
 * An unreadable marker must not accidentally resume collection.
 * @param paths - User data paths.
 * @returns Whether collection must remain stopped.
 */
export async function isDisabled(paths: AgentWatchPaths): Promise<boolean> {
  try {
    await fs.lstat(disabledFile(paths));

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}
