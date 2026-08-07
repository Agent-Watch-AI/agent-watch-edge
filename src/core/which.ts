import fs from 'node:fs';
import path from 'node:path';
import type { Env } from './env.js';

/** Minimal PATH lookup so agent detection needs no child processes. */
export function findExecutable(env: Env, name: string): string | undefined {
  const pathVar = env.vars['PATH'] ?? '';
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  const candidates = env.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  for (const dir of dirs) {
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && (env.platform === 'win32' || (stat.mode & 0o111) !== 0)) {
          return full;
        }
      } catch {
        // not here; keep looking
      }
    }
  }
  return undefined;
}
