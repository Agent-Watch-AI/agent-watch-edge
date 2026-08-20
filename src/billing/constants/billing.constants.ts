import path from 'node:path';

/** Local auth state each agent records its billing arrangement in. */
export const CLAUDE_STATE_FILE = '.claude.json';
export const CODEX_AUTH_FILE = path.join('.codex', 'auth.json');
export const GEMINI_SETTINGS_FILE = path.join('.gemini', 'settings.json');
export const GEMINI_OAUTH_FILE = path.join('.gemini', 'oauth.json');

/** Environment variables that put an agent on per-token API billing. */
export const CLAUDE_BEDROCK_VAR = 'CLAUDE_CODE_USE_BEDROCK';
export const CLAUDE_VERTEX_VAR = 'CLAUDE_CODE_USE_VERTEX';
export const ANTHROPIC_API_KEY_VAR = 'ANTHROPIC_API_KEY';
export const GEMINI_API_KEY_VARS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI'] as const;

/** Fields the agents' own auth state uses. */
export const CLAUDE_OAUTH_FIELD = 'oauthAccount';
export const CLAUDE_BILLING_TYPE_FIELD = 'billingType';
export const CLAUDE_API_KEY_RESPONSES_FIELD = 'customApiKeyResponses';
export const CLAUDE_APPROVED_FIELD = 'approved';
export const CODEX_AUTH_MODE_FIELD = 'auth_mode';
export const CODEX_API_KEY_FIELD = 'OPENAI_API_KEY';
export const GEMINI_MODE_FIELDS = ['auth_mode', 'billingType'] as const;
export const GEMINI_API_KEY_FIELDS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] as const;

/** Auth-mode values Codex reports. */
export const CODEX_SUBSCRIPTION_MODE = 'chatgpt';
export const CODEX_API_MODE = 'apikey';

/** Substrings that positively identify a billing arrangement. */
export const SUBSCRIPTION_MARKER = 'subscription';
export const API_MARKER = 'api';

/**
 * Shortest approval entry we will match a key against.
 *
 * Claude Code records an approved environment key as a hash prefix or a key
 * tail; anything shorter than this would match far too many keys to mean
 * anything.
 */
export const MIN_APPROVAL_ENTRY_LENGTH = 8;

/** Environment values that mean "not set", beyond an absent variable. */
export const FALSY_ENV_VALUES: ReadonlySet<string> = new Set(['', '0', 'false']);

/** Agent ids that authenticate through the shared ~/.gemini Google account. */
export const GOOGLE_ACCOUNT_AGENTS: ReadonlySet<string> = new Set(['gemini', 'antigravity']);
