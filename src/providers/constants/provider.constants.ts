/** Substring identifying AgentWatch-owned hook entries in agent configs. */
export const HOOK_COMMAND_MARKER = 'agentwatch';

/**
 * Agent ids a hook command may name.
 *
 * The allowlist is what stops a foreign `my-tool hook --agent x` from being
 * claimed — and then deleted — as AgentWatch's own.
 */
export const KNOWN_AGENT_IDS: ReadonlySet<string> = new Set(['claude', 'codex', 'cursor', 'gemini', 'antigravity']);

/** An executable named `agentwatch`, with or without a platform suffix. */
export const RE_AGENTWATCH_BINARY = /^(?:agentwatch)(?:\.(?:exe|cmd|ps1|js|cjs|mjs))?$/;

/**
 * A Node-compatible runtime.
 *
 * buildHookCommand embeds process.execPath, so hooks written by earlier
 * installs may name any of these — including versioned binaries (node22) and
 * TypeScript runners (tsx, deno). Failing to recognize one would leave the
 * stale hook in place next to a fresh duplicate, and every turn would then be
 * processed — and counted — twice.
 */
export const RE_NODE_BINARY = /^(?:node[\d.]*|nodejs|bun|tsx|deno)(?:\.exe)?$/i;

/** The CLI entry point, in any form the build or a dev run produces. */
export const RE_CLI_SCRIPT = /^cli\.(?:ts|mts|js|mjs|cjs)$/;

/** Path separator, either platform's. */
export const RE_PATH_SEPARATOR = /[\\/]/;

/** Shell control operators; their presence disqualifies a command outright. */
export const RE_SHELL_CONTROL = /[|&;<>\r\n]/;

/** Characters a double quote still escapes inside a quoted argument. */
export const RE_DOUBLE_QUOTE_ESCAPABLE = /["\\$`]/;

export const RE_WHITESPACE = /\s/;

/** Argument shape that forces quoting when a hook command is generated. */
export const RE_NEEDS_QUOTING = /[\s"'\\$`]/;
export const RE_QUOTE_ESCAPE = /(["\\$`])/g;
