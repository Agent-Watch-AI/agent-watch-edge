/**
 * Patterns the shell-directory reader uses. Every one of them is applied to a
 * command held in memory inside one pipeline stage; see `shell-directories.ts`.
 */

/** A heredoc and its body: file content, not the command. */
export const RE_HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g;

/** What a heredoc is replaced with, so the command around it still reads. */
export const HEREDOC_PLACEHOLDER = '<<HEREDOC';

/** Command separators: each piece is read on its own, in order. */
export const RE_SHELL_SEPARATORS = /&&|\|\||;|\n/;

/** One argument: double-quoted, single-quoted, or a bare word. */
const ARG = String.raw`("[^"]+"|'[^']+'|[^\s;&|()<>]+)`;

/** `cd X` / `pushd X`: X is a directory, and later relative paths resolve against it. */
export const RE_CHANGE_DIRECTORY = new RegExp(String.raw`(?:^|[\s(])(?:cd|pushd)\s+` + ARG, 'g');

/** Arguments that name a directory outright, relative or not. */
export const RE_DIRECTORY_ARGUMENTS: readonly RegExp[] = [
  new RegExp(String.raw`\bgit\s+(?:-c\s+\S+\s+)*-C\s+` + ARG, 'g'),
  new RegExp(String.raw`--(?:work-tree|git-dir)[= ]` + ARG, 'g'),
  // Only -b, -B and --reason take a value; every other option is a flag, and
  // the first bare word after them is the path.
  new RegExp(String.raw`\bworktree\s+add\s+(?:(?:-[bB]|--reason)\s+(?:"[^"]*"|'[^']*'|\S+)\s+|-\S+\s+)*` + ARG, 'g')
];

/** A quoted absolute or home-relative path anywhere in the command. */
export const RE_QUOTED_ABSOLUTE = /(["'])((?:\/|~\/|\$HOME\/|\$\{HOME\}\/)[^"'\n]+)\1/g;

/** A bare absolute or home-relative path, not glued to a longer word. */
export const RE_BARE_ABSOLUTE = /(?<![\w/.$"'-])((?:\/|~\/|\$HOME\/|\$\{HOME\}\/)[^\s"';|&()<>]+)/g;

/** A bare `./` or `../` path. */
export const RE_DOT_RELATIVE = /(?<![\w/.-])(\.\.?\/[^\s"';|&()<>]+)/g;

/** `./x` or `../x`: relative on purpose, so resolved even outside a directory argument. */
export const RE_DOT_PREFIX = /^\.\.?\//;

/** Home spelled the three ways a command spells it. */
export const RE_HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;

/** Anything the shell would still expand: not a path this reader can know. */
export const RE_UNEXPANDED = /[$`*?[\]{}]/;

/** Surrounding quotes of one argument. */
export const RE_SURROUNDING_QUOTES = /^["']|["']$/g;

/** Directories one command may name before the rest are ignored: each one costs a walk of `stat`s. */
export const MAX_SHELL_DIRECTORIES = 32;
