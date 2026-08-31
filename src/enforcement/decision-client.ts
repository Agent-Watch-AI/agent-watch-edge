import { debugLog } from '../core/logger.js';
import { edgeHeaders } from '../transport/headers.js';
import { DEVELOPER_ID_PARAM } from './constants/enforcement.constants.js';
import { cacheTtlSchema, decisionSchema } from './schemas/enforcement.schema.js';
import type { AnsweredDecision, DecisionRequest } from './types/enforcement.types.js';

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
export async function requestDecision(request: DecisionRequest): Promise<AnsweredDecision | undefined> {
  const fetchFn = request.fetchFn ?? fetch;

  try {
    const response = await fetchFn(decisionUrl(request), {
      method: 'GET',
      // A GET carries no body, so no content type: the identifying triple is all
      // the platform needs to resolve the tenant.
      headers: edgeHeaders(request.token, request.installationId),
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
function readDecision(body: unknown): AnsweredDecision | undefined {
  const parsed = decisionSchema.safeParse(body);

  if (!parsed.success) {
    debugLog('enforcement: unreadable decision; allowing');

    return undefined;
  }

  return { ...parsed.data, cacheTtlMs: readCacheTtlMs(body) };
}

/**
 * How long the platform asked this answer to be kept, when it asked usably.
 *
 * Read after the decision and separately from it, so a TTL this side cannot make
 * sense of costs nothing but the advice: an unreadable number means the local
 * configuration decides, exactly as it does when the platform sends none.
 *
 * @param body - Whatever the endpoint returned.
 * @returns The advised TTL, or undefined when there is no usable advice.
 */
function readCacheTtlMs(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;

  const parsed = cacheTtlSchema.safeParse((body as Record<string, unknown>).cache_ttl_ms);

  if (!parsed.success) {
    debugLog('enforcement: unusable cache_ttl_ms; keeping the configured TTL');

    return undefined;
  }

  return parsed.data;
}
