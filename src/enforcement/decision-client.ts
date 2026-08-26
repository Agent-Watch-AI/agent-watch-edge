import { debugLog } from '../core/logger.js';
import { bridgeHeaders } from '../transport/headers.js';
import { DEVELOPER_ID_PARAM } from './constants/enforcement.constants.js';
import { decisionSchema } from './schemas/enforcement.schema.js';
import type { DecisionRequest, EnforcementDecision } from './types/enforcement.types.js';

/**
 * Ask the platform whether one developer may make an LLM call.
 *
 * Never throws, and answers `undefined` — "nobody said no" — for everything
 * that is not a complete, valid decision: a timeout, a network error, any
 * non-2xx status, a body that is not JSON, and a body whose decision this code
 * cannot read. Only the caller's own allow default gets built out of those; a
 * refusal can only ever come from a body that validates.
 *
 * @param request - Destination, credentials, identity and timeout.
 * @returns The platform's decision, or undefined when it did not give one.
 */
export async function requestDecision(request: DecisionRequest): Promise<EnforcementDecision | undefined> {
  const fetchFn = request.fetchFn ?? fetch;

  try {
    const response = await fetchFn(decisionUrl(request), {
      method: 'GET',
      // A GET carries no body, so no content type: the identifying triple is all
      // the platform needs to resolve the tenant.
      headers: bridgeHeaders(request.token, request.installationId),
      signal: AbortSignal.timeout(request.timeoutMs)
    });

    if (!response.ok) {
      debugLog(`enforcement: HTTP ${response.status}; allowing`);

      return undefined;
    }

    return readDecision(await response.json());
  } catch (error) {
    // Never log the response body: the message names a person and what they
    // spent, and this line goes to the developer's terminal.
    debugLog('enforcement: check failed; allowing:', (error as Error).name || 'network error');

    return undefined;
  }
}

/**
 * The endpoint with the identity attached.
 *
 * @param request - The request being made.
 * @returns The full URL.
 */
function decisionUrl(request: DecisionRequest): string {
  const url = new URL(request.url);

  url.searchParams.set(DEVELOPER_ID_PARAM, request.developerId);

  return url.toString();
}

/**
 * A decoded body, if it is a decision at all.
 *
 * @param body - Whatever the endpoint returned.
 * @returns The decision, or undefined when the body is not one.
 */
function readDecision(body: unknown): EnforcementDecision | undefined {
  const parsed = decisionSchema.safeParse(body);

  if (!parsed.success) {
    debugLog('enforcement: unreadable decision; allowing');

    return undefined;
  }

  return parsed.data;
}
