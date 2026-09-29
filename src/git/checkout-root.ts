import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalRoot } from '../config/root-config.js';
import { GATE_MAX_WALK_DEPTH } from './constants/git.constants.js';
import { findGitDir } from './gate-checkout.js';

/**
 * The checkout a path lies in, as its real root.
 *
 * The path may name a file, or a directory a command is about to create, so the
 * walk first climbs to a directory that exists. `stat`s only, no git: this runs
 * on tool hooks, and for every directory a shell command names. Real, because a
 * symlink inside one folder can lead into another tenant's checkout, and two
 * spellings of one checkout are one candidate.
 *
 * @param target - Absolute file or directory path.
 * @returns The canonical checkout root, or undefined outside any repository.
 */
export async function checkoutRootOf(target: string): Promise<string | undefined> {
  const directory = await existingDirectory(target);
  const location = directory === undefined ? undefined : await findGitDir(directory);

  return location ? canonicalRoot(location.root) : undefined;
}

/**
 * The nearest existing directory at or above a path.
 *
 * @param target - Absolute path.
 * @returns The directory, or undefined when none could be found.
 */
async function existingDirectory(target: string): Promise<string | undefined> {
  let current = path.resolve(target);

  for (let depth = 0; depth < GATE_MAX_WALK_DEPTH; depth++) {
    const stat = await fs.stat(current).catch(() => undefined);

    if (stat?.isDirectory()) return current;

    const parent = path.dirname(current);

    if (parent === current) return undefined;

    current = parent;
  }

  return undefined;
}
