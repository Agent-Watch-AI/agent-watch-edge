import path from 'node:path';
import { asRecord, firstString } from '../core/object.js';
import type { Env, UnknownRecord } from '../core/types/core.types.js';
import { sha256Hex } from '../events/event-id.js';
import type { UsageBillingMode } from '../events/types/events.types.js';
import { readJsonFile } from '../storage/json-file.js';
import {
  ANTHROPIC_API_KEY_VAR,
  API_MARKER,
  CLAUDE_API_KEY_RESPONSES_FIELD,
  CLAUDE_APPROVED_FIELD,
  CLAUDE_BEDROCK_VAR,
  CLAUDE_BILLING_TYPE_FIELD,
  CLAUDE_OAUTH_FIELD,
  CLAUDE_STATE_FILE,
  CLAUDE_VERTEX_VAR,
  CODEX_API_KEY_FIELD,
  CODEX_API_MODE,
  CODEX_AUTH_FILE,
  CODEX_AUTH_MODE_FIELD,
  CODEX_SUBSCRIPTION_MODE,
  FALSY_ENV_VALUES,
  GEMINI_API_KEY_FIELDS,
  GEMINI_API_KEY_VARS,
  GEMINI_MODE_FIELDS,
  GEMINI_OAUTH_FILE,
  GEMINI_SETTINGS_FILE,
  GOOGLE_ACCOUNT_AGENTS,
  MIN_APPROVAL_ENTRY_LENGTH,
  SUBSCRIPTION_MARKER
} from './constants/billing.constants.js';

/**
 * How the developer pays for this agent.
 *
 * A flat subscription (Claude Pro/Max, a ChatGPT plan) and per-token API billing
 * price the same turn completely differently, so a summary that guessed would be
 * worse than one that admits it does not know. Only positively recognized states
 * are classified; every read problem, and every value we do not recognize,
 * degrades to 'unknown'.
 *
 * @param agentId - Internal provider id.
 * @param env - Environment supplying HOME and the relevant variables.
 * @returns The billing mode.
 */
export async function detectBillingMode(agentId: string, env: Env): Promise<UsageBillingMode> {
  try {
    if (agentId === 'claude') return await detectClaude(env);

    if (agentId === 'codex') return await detectCodex(env);

    if (GOOGLE_ACCOUNT_AGENTS.has(agentId)) return await detectGoogleAccount(env);
  } catch {
    // Any read or parse failure: we simply do not know.
  }

  return 'unknown';
}

/**
 * Claude Code's billing arrangement.
 *
 * @param env - Environment supplying HOME and the relevant variables.
 * @returns The billing mode.
 */
async function detectClaude(env: Env): Promise<UsageBillingMode> {
  // Bedrock and Vertex sessions always bill per token.
  if (isSet(env.vars[CLAUDE_BEDROCK_VAR]) || isSet(env.vars[CLAUDE_VERTEX_VAR])) return 'api';

  const state = await readRecord(path.join(env.home, CLAUDE_STATE_FILE));
  const apiKey = env.vars[ANTHROPIC_API_KEY_VAR];

  if (isSet(apiKey) && envApiKeyUsed(state, apiKey!)) return 'api';

  const billingType = asRecord(state?.[CLAUDE_OAUTH_FIELD])?.[CLAUDE_BILLING_TYPE_FIELD];

  if (typeof billingType === 'string' && billingType.includes(SUBSCRIPTION_MARKER)) return 'subscription';

  return 'unknown';
}

/**
 * Whether an environment API key is what Claude Code actually bills through.
 *
 * Claude Code only bills through an environment `ANTHROPIC_API_KEY` after the
 * user approves it (recorded in `customApiKeyResponses`); a key merely exported
 * for other tooling leaves the login's billing untouched. Approval entries have
 * varied across releases — a key hash prefix, or a key tail — so both forms are
 * recognized.
 *
 * @param state - Decoded `~/.claude.json`, when it exists.
 * @param apiKey - The exported key.
 * @returns True when the key is the effective credential.
 */
function envApiKeyUsed(state: UnknownRecord | undefined, apiKey: string): boolean {
  // No local Claude state at all: the key is the only auth there is.
  if (!state) return true;

  const responses = asRecord(state[CLAUDE_API_KEY_RESPONSES_FIELD]);
  const approved = responses?.[CLAUDE_APPROVED_FIELD];

  if (!Array.isArray(approved)) return false;

  const hash = sha256Hex(apiKey);

  return approved.some(
    (entry) => typeof entry === 'string' && entry.length >= MIN_APPROVAL_ENTRY_LENGTH && (hash.startsWith(entry) || apiKey.endsWith(entry))
  );
}

/**
 * Codex's billing arrangement.
 *
 * @param env - Environment supplying HOME.
 * @returns The billing mode.
 */
async function detectCodex(env: Env): Promise<UsageBillingMode> {
  const auth = await readRecord(path.join(env.home, CODEX_AUTH_FILE));

  if (!auth) return 'unknown';

  const mode = auth[CODEX_AUTH_MODE_FIELD];

  if (mode === CODEX_SUBSCRIPTION_MODE) return 'subscription';

  if (mode === CODEX_API_MODE) return 'api';

  if (typeof auth[CODEX_API_KEY_FIELD] === 'string' && auth[CODEX_API_KEY_FIELD] !== '') return 'api';

  return 'unknown';
}

/**
 * The billing arrangement of an agent signed in through the shared Google
 * account state (Gemini CLI, Antigravity).
 *
 * @param env - Environment supplying HOME and the relevant variables.
 * @returns The billing mode.
 */
async function detectGoogleAccount(env: Env): Promise<UsageBillingMode> {
  if (GEMINI_API_KEY_VARS.some((name) => isSet(env.vars[name]))) return 'api';

  const state = (await readRecord(path.join(env.home, GEMINI_SETTINGS_FILE))) ?? (await readRecord(path.join(env.home, GEMINI_OAUTH_FILE)));

  if (!state) return 'unknown';

  const mode = firstString(state, GEMINI_MODE_FIELDS);

  if (mode?.includes(SUBSCRIPTION_MARKER)) return 'subscription';

  if (mode?.includes(API_MARKER)) return 'api';

  if (GEMINI_API_KEY_FIELDS.some((field) => typeof state[field] === 'string')) return 'api';

  return 'unknown';
}

/**
 * Read a JSON object, treating anything unusable as absent.
 *
 * @param filePath - File to read.
 * @returns The object, or undefined.
 */
async function readRecord(filePath: string): Promise<UnknownRecord | undefined> {
  const read = await readJsonFile(filePath);

  if (read.state !== 'ok') return undefined;

  return asRecord(read.value);
}

/**
 * Whether an environment variable is meaningfully set.
 *
 * @param value - The variable's value.
 * @returns True when it is set to something that is not a disabling value.
 */
function isSet(value: string | undefined): boolean {
  if (value === undefined) return false;

  return !FALSY_ENV_VALUES.has(value.toLowerCase());
}
