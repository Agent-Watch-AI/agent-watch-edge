import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PERMISSION_MASK, RE_UNSAFE_STAMP_CHARS } from './constants/storage.constants.js';

/**
 * Write a file so readers never observe a partial one: temp file, fsync,
 * rename.
 *
 * The fsync is not optional. `rename` orders metadata, not contents, so a
 * crash shortly after it can leave the new name pointing at zero-length data.
 *
 * With no explicit mode the target's existing mode is preserved: renaming a
 * default-mode temp file over a 0600 config must not loosen its permissions.
 *
 * @param filePath - Destination path; parent directories are created.
 * @param contents - Full file contents.
 * @param mode - Permission bits to force, or undefined to preserve the
 *   target's.
 */
export async function writeFileAtomic(filePath: string, contents: string, mode?: number): Promise<void> {
  const dir = path.dirname(filePath);

  await fs.mkdir(dir, { recursive: true });

  const effectiveMode = mode ?? (await currentMode(filePath));
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);

  try {
    const handle = await fs.open(tmp, 'w', effectiveMode);

    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/**
 * Copy a file into the backups directory before we mutate it.
 *
 * @param filePath - File about to be modified.
 * @param backupsDir - Directory backups are collected in.
 * @param now - Timestamp for the backup name.
 * @returns The backup path, or undefined when there was nothing to copy.
 */
export async function backupFile(filePath: string, backupsDir: string, now: Date): Promise<string | undefined> {
  const sourceMode = await currentMode(filePath);

  if (sourceMode === undefined) return undefined;

  await fs.mkdir(backupsDir, { recursive: true });

  const stamp = now.toISOString().replace(RE_UNSAFE_STAMP_CHARS, '-');
  const target = path.join(backupsDir, `${path.basename(filePath)}.${stamp}.bak`);

  await fs.copyFile(filePath, target);
  // A backup of a credential-bearing file must never end up more readable
  // than the file it copies, whatever the platform's copy semantics.
  await fs.chmod(target, sourceMode);

  return target;
}

/**
 * Permission bits of an existing file.
 *
 * @param filePath - File to inspect.
 * @returns Its mode, or undefined when the file does not exist.
 */
async function currentMode(filePath: string): Promise<number | undefined> {
  try {
    return (await fs.stat(filePath)).mode & PERMISSION_MASK;
  } catch {
    // New file: the platform default applies.
    return undefined;
  }
}
