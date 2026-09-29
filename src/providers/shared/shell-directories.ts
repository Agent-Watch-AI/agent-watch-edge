import path from 'node:path';
import {
  HEREDOC_PLACEHOLDER,
  MAX_SHELL_DIRECTORIES,
  RE_BARE_ABSOLUTE,
  RE_CHANGE_DIRECTORY,
  RE_DIRECTORY_ARGUMENTS,
  RE_DOT_PREFIX,
  RE_DOT_RELATIVE,
  RE_HEREDOC,
  RE_HOME_PREFIX,
  RE_QUOTED_ABSOLUTE,
  RE_SHELL_SEPARATORS,
  RE_SURROUNDING_QUOTES,
  RE_UNEXPANDED
} from './constants/shell-directories.constants.js';

/**
 * The directories a shell command names, as absolute paths.
 *
 * Agents do their work through the shell far more than through file tools, and
 * often in a checkout other than the folder they sit in: `cd ../worktree && git
 * commit`. The command is the only place that says so. This reads it for
 * directory names and nothing else — no verb decides anything; git later says
 * which named checkout actually changed.
 *
 * Pure, and deliberately the only thing that ever sees the command: the caller
 * holds the text in memory, passes it here, keeps the paths only long enough to
 * turn them into checkout roots, and drops both. Nothing of it is stored.
 *
 * ponytail: a regex reader, not a shell parser. Variables, globs and
 * subshell-computed paths are skipped rather than guessed, and a path that is
 * only an argument (a script run from another repository) is nominated like any
 * other; it can only win when nothing changed. The upgrade is a real tokenizer.
 *
 * @param command - The shell command, in memory.
 * @param cwd - The directory the command runs in.
 * @param home - Home directory, for `~/` and `$HOME/`; unknown means those are skipped.
 * @returns Absolute paths, deduplicated, at most {@link MAX_SHELL_DIRECTORIES}.
 */
export function shellDirectories(command: string, cwd: string, home: string | undefined): string[] {
  const found = new Set<string>();
  let base = cwd;

  for (const piece of command.replace(RE_HEREDOC, HEREDOC_PLACEHOLDER).split(RE_SHELL_SEPARATORS)) {
    for (const match of piece.matchAll(RE_CHANGE_DIRECTORY)) {
      const directory = resolveArgument(match[1], base, home, true);

      if (!directory) continue;

      found.add(directory);
      // A lasting `cd` in one command moves every relative path after it.
      base = directory;
    }

    for (const pattern of RE_DIRECTORY_ARGUMENTS) {
      for (const match of piece.matchAll(pattern)) addResolved(found, resolveArgument(match[1], base, home, true));
    }

    for (const match of piece.matchAll(RE_QUOTED_ABSOLUTE)) addResolved(found, resolveArgument(match[2], base, home, false));

    for (const match of piece.matchAll(RE_BARE_ABSOLUTE)) addResolved(found, resolveArgument(match[1], base, home, false));

    for (const match of piece.matchAll(RE_DOT_RELATIVE)) addResolved(found, resolveArgument(match[1], base, home, false));
  }

  return [...found].slice(0, MAX_SHELL_DIRECTORIES);
}

function addResolved(found: Set<string>, directory: string | undefined): void {
  if (directory) found.add(directory);
}

/**
 * One argument as an absolute path, when it can be known without a shell.
 *
 * @param raw - The argument as written.
 * @param base - What a relative path is relative to.
 * @param home - Home directory, when known.
 * @param anyRelative - The argument is a directory by position (`cd X`), so a bare relative name counts.
 * @returns The absolute path, or undefined.
 */
function resolveArgument(raw: string | undefined, base: string, home: string | undefined, anyRelative: boolean): string | undefined {
  const unquoted = raw?.replace(RE_SURROUNDING_QUOTES, '');

  if (!unquoted || unquoted.startsWith('-')) return undefined;

  const homed = expandHome(unquoted, home);

  if (!homed || RE_UNEXPANDED.test(homed)) return undefined;

  if (path.isAbsolute(homed)) return path.resolve(homed);

  if (!anyRelative && !RE_DOT_PREFIX.test(homed)) return undefined;

  return path.resolve(base, homed);
}

/**
 * `~`, `$HOME` and `${HOME}` at the start of a path, expanded.
 *
 * @param value - The unquoted argument.
 * @param home - Home directory, when known.
 * @returns The expanded path, or undefined when it needs a home nobody gave.
 */
function expandHome(value: string, home: string | undefined): string | undefined {
  if (!RE_HOME_PREFIX.test(value)) return value;

  return home ? value.replace(RE_HOME_PREFIX, home) : undefined;
}
