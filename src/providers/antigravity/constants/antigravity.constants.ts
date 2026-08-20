export const ANTIGRAVITY_PROVIDER_ID = 'antigravity';
export const ANTIGRAVITY_DISPLAY_NAME = 'Google Antigravity';

/** Antigravity shares Gemini's home; its own config lives one level down. */
export const ANTIGRAVITY_ROOT_SEGMENTS = ['.gemini', 'config'] as const;
export const ANTIGRAVITY_CLI_DIR_SEGMENTS = ['.gemini', 'antigravity-cli'] as const;
export const ANTIGRAVITY_HOOKS_FILE = 'hooks.json';
export const ANTIGRAVITY_EXECUTABLES = ['agy', 'antigravity'] as const;

/**
 * Antigravity reads `~/.gemini/config/hooks.json` as a map of *named* hook
 * groups — its log line is "loaded N named hooks from N hooks.json file(s)" — so
 * AgentWatch owns exactly one top-level key and never touches another tool's
 * group.
 */
export const ANTIGRAVITY_GROUP_NAME = 'agentwatch';

export const ANTIGRAVITY_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop'] as const;

/** Tool-scoped events take a matcher; the rest are plain handler lists. */
export const ANTIGRAVITY_MATCHED_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PostToolUse']);

/**
 * `HookHandlerConfig.timeout` carries no unit suffix, and Gemini CLI — the same
 * Google hook runner — reads the field as milliseconds with a 60,000 default. A
 * bare `30` there timed every AgentWatch hook out before node could start; see
 * the identical constant in gemini.constants.ts. Milliseconds is also the safe
 * reading of the two: an over-large upper bound costs nothing, because the hook
 * exits in well under a second either way.
 */
export const ANTIGRAVITY_HOOK_TIMEOUT_MILLISECONDS = 30_000;

/**
 * The decision each hook result must carry.
 *
 * `decision` is a required field of both `PreToolHookResult` and
 * `StopHookResult`, and Antigravity has a dedicated `PreToolHookDeniedError`
 * for a pre-tool hook that does not answer. A single `{}` for every hook — the
 * previous behavior — therefore did not merely fail to observe: it blocked every
 * tool call the agent tried to make. The remaining result messages
 * (`PostToolHookResult`, the invocation hooks, `SessionStartHookResult`) carry
 * no decision, so silence is correct for those.
 */
export const ANTIGRAVITY_HOOK_DECISIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  PreToolUse: { decision: 'allow' },
  Stop: { decision: 'stop' }
};

/**
 * Answer used for a payload we cannot classify at all.
 *
 * A pre-tool allow: the one payload shape we cannot read is also the one where
 * staying silent would stall the agent, and telemetry must never do that.
 */
export const ANTIGRAVITY_FALLBACK_DECISION = ANTIGRAVITY_HOOK_DECISIONS['PreToolUse']!;

/**
 * Antigravity names its model the way its picker shows it — `Claude Opus 4.6
 * (Thinking)`, `Gemini 3 Pro (High)` — not the way an API does. Every other
 * agent reports a model *id*, so a display name reaches the backend as a model
 * nobody has a price for and as a second name for a model the ledger already
 * knows under its id. The patterns below turn one into the other.
 */

/** Trailing selector the picker appends: `(Thinking)`, `(High)`, `(Fast)`. */
export const RE_MODEL_QUALIFIER = /\s*\([^)]*\)\s*$/;

/** Any run of whitespace, which in an id is a single hyphen. */
export const RE_MODEL_WHITESPACE = /\s+/g;

/**
 * Anthropic writes a version as `claude-opus-4-6`; Google and OpenAI keep the
 * dot (`gemini-3.1-pro`, `gpt-5.2`). Converting dots for everyone would invent
 * `gemini-3-1-pro`, which matches no price and no other row in the ledger.
 */
export const RE_MODEL_VERSION_DOT = /\./g;
export const DOTLESS_MODEL_FAMILY = 'claude';

/** oneof member of `HookArgs` -> the hook Antigravity fired, in hooks.json naming. */
export const ANTIGRAVITY_HOOK_EVENT_BY_ARGS = {
  preToolHookArgs: 'PreToolUse',
  postToolHookArgs: 'PostToolUse',
  preInvocationHookArgs: 'PreInvocation',
  postInvocationHookArgs: 'PostInvocation',
  stopHookArgs: 'Stop',
  sessionStartHookArgs: 'SessionStart'
} as const;
