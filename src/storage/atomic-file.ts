import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Write via temp file + rename so readers never observe a partial file.
 * When no mode is given, the target's existing mode is preserved — renaming a
 * default-mode temp file over a 0600 config must not loosen its permissions.
 */
export async function writeFileAtomic(filePath: string, contents: string, mode?: number): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  let effectiveMode = mode;
  if (effectiveMode === undefined) {
    try {
      effectiveMode = (await fs.stat(filePath)).mode & 0o777;
    } catch {
      // New file: platform default applies.
    }
  }
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    // fsync before rename: without it a crash/power loss shortly after the
    // rename can leave the new name pointing at zero-length or partial data —
    // rename alone orders metadata, not file contents.
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

/** Copy the current file (if any) into backupsDir before we mutate it. */
export async function backupFile(filePath: string, backupsDir: string, now: Date): Promise<string | undefined> {
  let sourceMode: number;
  try {
    sourceMode = (await fs.stat(filePath)).mode & 0o777;
  } catch {
    return undefined;
  }
  await fs.mkdir(backupsDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupsDir, `${path.basename(filePath)}.${stamp}.bak`);
  await fs.copyFile(filePath, target);
  // A backup of a credential-bearing file must never be more readable than
  // the file it copies, whatever the platform's copy semantics.
  await fs.chmod(target, sourceMode);
  return target;
}
