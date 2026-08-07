import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Write via temp file + rename so readers never observe a partial file. */
export async function writeFileAtomic(filePath: string, contents: string, mode?: number): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, contents, mode !== undefined ? { mode } : {});
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/** Copy the current file (if any) into backupsDir before we mutate it. */
export async function backupFile(filePath: string, backupsDir: string, now: Date): Promise<string | undefined> {
  try {
    await fs.access(filePath);
  } catch {
    return undefined;
  }
  await fs.mkdir(backupsDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupsDir, `${path.basename(filePath)}.${stamp}.bak`);
  await fs.copyFile(filePath, target);
  return target;
}
