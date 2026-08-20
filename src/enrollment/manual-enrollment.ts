import { ALLOWED_PROTOCOLS, ENDPOINT_PROMPT, RE_TRAILING_SLASHES, TOKEN_PROMPT } from './constants/enrollment.constants.js';
import type { EnrollmentInput, EnrollmentProvider, EnrollmentResult } from './types/enrollment.types.js';

/**
 * Enrollment by asking the developer.
 *
 * Fails loudly rather than guessing: an install pointed at the wrong backend
 * would send this repository's prompts and tool output somewhere the user never
 * chose, so a missing endpoint is an error, not a default.
 */
export class ManualEnrollmentProvider implements EnrollmentProvider {
  /**
   * Resolve the backend endpoint and token.
   *
   * @param input - Flags, existing configuration and the interactive prompt.
   * @returns The endpoint and token to configure.
   * @throws When no usable endpoint can be obtained.
   */
  async enroll(input: EnrollmentInput): Promise<EnrollmentResult> {
    if (input.setupUrl) {
      throw new Error('enrollment URLs are not supported yet; pass the backend base URL via --endpoint or the prompt');
    }

    const endpoint = await this.resolveEndpoint(input);

    if (!endpoint) {
      throw new Error('no backend endpoint provided (use --endpoint or run interactively)');
    }

    assertHttpUrl(endpoint);

    return { endpoint: endpoint.replace(RE_TRAILING_SLASHES, ''), token: await this.resolveToken(input) };
  }

  /**
   * The endpoint from the flag, the existing config, or the prompt.
   *
   * @param input - Enrollment input.
   * @returns The endpoint, or undefined when there is none.
   */
  private async resolveEndpoint(input: EnrollmentInput): Promise<string | undefined> {
    if (input.endpoint) return input.endpoint;

    if (!input.ask) return undefined;

    return (await input.ask(ENDPOINT_PROMPT)).trim();
  }

  /**
   * The token from the flag, the existing config, or the prompt.
   *
   * @param input - Enrollment input.
   * @returns The token, or undefined when the backend needs none.
   */
  private async resolveToken(input: EnrollmentInput): Promise<string | undefined> {
    if (input.token !== undefined) return input.token;

    if (!input.ask) return undefined;

    return (await input.ask(TOKEN_PROMPT)).trim() || undefined;
  }
}

/**
 * Reject anything that is not an http(s) URL.
 *
 * @param value - The endpoint as entered.
 * @throws When the value is not a usable http(s) URL.
 */
function assertHttpUrl(value: string): void {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid URL: ${value}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`backend URL must be http(s), got ${url.protocol}`);
  }
}
