import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backupFile } from '../src/storage/atomic-file.js';

describe('backupFile', () => {
  it('preserves the source file mode on the backup', async () => {
    const base = path.join(os.tmpdir(), `aw-backup-${Math.random().toString(36).slice(2)}`);
    const source = path.join(base, 'config.toml');
    const backups = path.join(base, 'backups');

    await fs.mkdir(base, { recursive: true });
    await fs.writeFile(source, 'Authorization = "Bearer secret"', { mode: 0o600 });

    const target = await backupFile(source, backups, new Date('2026-08-15T10:00:00Z'));

    expect(target).toBeDefined();
    const mode = (await fs.stat(target as string)).mode & 0o777;

    expect(mode).toBe(0o600);
    await fs.rm(base, { recursive: true, force: true });
  });
});
