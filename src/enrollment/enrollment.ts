import { isDeliverableUrl } from '../config/schemas/config.schema.js';
import { DELIVERABLE_URL_MESSAGE } from '../config/constants/config.constants.js';
import { ENDPOINT_PROMPT, RE_TRAILING_SLASHES, TOKEN_PROMPT } from './constants/enrollment.constants.js';
import type { EnrollmentInput, EnrollmentResult } from './types/enrollment.types.js';

/**
 * Acquire the backend endpoint and token by asking the developer.
 *
 * Fails loudly rather than guessing: an install pointed at the wrong backend
 * would send this repository's prompts and tool output somewhere the user never
 * chose, so a missing endpoint is an error, not a default. The URL is checked
 * against the same rule the config schema applies on every later read, so a
 * bearer can never be configured onto a destination the schema would then
 * refuse to load.
 *
 * @param input - Flags, existing configuration and the interactive prompt.
 * @returns The endpoint and token to configure.
 * @throws When no usable endpoint can be obtained.
 */
export async function resolveEnrollment(input: EnrollmentInput): Promise<EnrollmentResult> {
  if (input.setupUrl) {
    throw new Error('enrollment URLs are not supported yet; pass the backend base URL via --endpoint or the prompt');
  }

  const endpoint = await resolveEndpoint(input);

  if (!endpoint) {
    throw new Error('no backend endpoint provided (use --endpoint or run interactively)');
  }

  const trimmed = endpoint.replace(RE_TRAILING_SLASHES, '');

  if (!isDeliverableUrl(trimmed)) {
    throw new Error(`backend URL ${DELIVERABLE_URL_MESSAGE}, got ${endpoint}`);
  }

  return { endpoint: trimmed, token: await resolveToken(input) };
}

/**
 * The endpoint from the flag, the existing config, or the prompt.
 *
 * @param input - Enrollment input.
 * @returns The endpoint, or undefined when there is none.
 */
async function resolveEndpoint(input: EnrollmentInput): Promise<string | undefined> {
  if (input.endpoint) return input.endpoint;

  if (!input.ask) return undefined;

  return (await input.ask(ENDPOINT_PROMPT)).trim() || undefined;
}

/**
 * The token from the flag, or the prompt. Optional: a backend may accept
 * unauthenticated batches.
 *
 * @param input - Enrollment input.
 * @returns The token, or undefined when there is none.
 */
async function resolveToken(input: EnrollmentInput): Promise<string | undefined> {
  if (input.token !== undefined) return input.token;

  if (!input.ask) return undefined;

  return (await input.ask(TOKEN_PROMPT)).trim() || undefined;
}
