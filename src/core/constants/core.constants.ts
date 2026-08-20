/**
 * Module-level constants and pre-compiled patterns for the core module.
 * Nothing here is built inside a function body (STYLEGUIDE 3.1).
 */

/** Prefix on every diagnostic line written to stderr. */
export const LOG_PREFIX = '[agentwatch]';

/** Environment variables that turn on debug logging. */
export const DEBUG_VAR = 'AGENTWATCH_DEBUG';
export const DEBUG_NAMESPACE_VAR = 'DEBUG';
export const DEBUG_NAMESPACE = 'agentwatch';

/** Values of AGENTWATCH_DEBUG that mean "on". O(1) membership. */
export const TRUTHY_DEBUG_VALUES = new Set(['1', 'true']);

/** First dotted version in arbitrary CLI output. */
export const RE_SEMVER = /\d+\.\d+\.\d+/;

/** Executable extensions probed on Windows, in resolution order. */
export const WINDOWS_EXECUTABLE_EXTENSIONS = ['.exe', '.cmd', '.bat'] as const;

/** Any of these bits set means "executable by someone" on POSIX. */
export const POSIX_EXECUTABLE_MASK = 0o111;
