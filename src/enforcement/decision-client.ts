import { debugLog } from '../core/logger.js';
import { edgeHeaders } from '../transport/headers.js';
import { BODY_TOO_LARGE } from '../transport/constants/transport.constants.js';
import { discardResponseBody, readCappedJson } from '../transport/response-body.js';
import { BRANCH_PARAM, DEVELOPER_ID_PARAM, MODEL_PARAM, REPOSITORY_PARAM, SYNTAX_ERROR_NAME, TIMEOUT_ERROR_NAMES } from './constants/enforcement.constants.js';
import { cacheTtlSchema, decisionSchema } from './schemas/enforcement.schema.js';
import type { DecisionOutcome, DecisionRequest, FailOpenReason } from './types/enforcement.types.js';

/**
 * Ask the platform whether one developer may make an LLM call.
 *
 * Never throws, and answers with a fail-open reason — "nobody said no, and
 * this is why" — for everything that is not a complete, valid decision: a
 * timeout, a network error, any non-2xx status, a body that is not JSON, a body
 * too large to be a decision, and a body whose decision this code cannot read.
 * Only the caller's own allow default gets built out of those; a refusal can
 * only ever come from a body that validates.
 *
 * @param request - Destination, credentials, identity and timeout.
 * @returns The platform's decision, or the reason it did not give one.
 */
export async function requestDecision(request: DecisionRequest): Promise<DecisionOutcome> {
  const fetchFn = request.fetchFn ?? fetch;

  try {
    const response = await fetchFn(decisionUrl(request), {
      method: 'GET',
      // A GET carries no body, so no content type: the identifying triple is all
      // the platform needs to resolve the tenant.
      headers: edgeHeaders(request.token, request.installationId),
      // The identity travels in the headers, so a redirect would hand the
      // bearer to somewhere nothing configured.
      redirect: 'error',
      signal: AbortSignal.timeout(request.timeoutMs)
    });

    if (!response.ok) {
      discardResponseBody(response);
      debugLog(`enforcement: HTTP ${response.status}; allowing`);

      return { failOpenReason: 'http_error' };
    }

    return readDecision(await readCappedJson(response));
  } catch (error) {
    const reason = thrownReason(error);

    // Never log or report the response body: the message names a person and
    // what they spent, and this line goes to the developer's terminal.
    debugLog('enforcement: check failed; allowing:', reason);

    return { failOpenReason: reason };
  }
}

/**
 * The category of a failure that threw, and nothing else about it.
 *
 * The timeout covers the body read too, so a slow body is a timeout. A body
 * that is not JSON, or too large to be a decision, is unreadable. Everything
 * else — refused, reset, DNS, a redirect the request forbids — is the network.
 *
 * @param error - Whatever was thrown.
 * @returns The reason to report.
 */
function thrownReason(error: unknown): FailOpenReason {
  // By shape, not by class: the timeout is a DOMException, and a fetch
  // injected by a test or a polyfill need not share this realm's Error.
  const thrown = typeof error === 'object' && error !== null ? (error as Partial<Error>) : {};

  if (thrown.name !== undefined && TIMEOUT_ERROR_NAMES.has(thrown.name)) return 'timeout';

  if (thrown.name === SYNTAX_ERROR_NAME || thrown.message === BODY_TOO_LARGE) return 'unreadable_response';

  return 'network_error';
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

  // Both or neither. The platform drops a half-stated pair, so sending one half
  // would only cost the request a parameter nobody reads.
  if (request.checkout) {
    url.searchParams.set(REPOSITORY_PARAM, request.checkout.repository);
    url.searchParams.set(BRANCH_PARAM, request.checkout.branch);
  }

  // Only when there is one. A collector that never learned its model asks the
  // question it asked before this parameter existed, byte for byte.
  if (request.model) {
    url.searchParams.set(MODEL_PARAM, request.model);
    // Named in the debug log because a cap is defined against the spelling the
    // platform sees in reported usage, and a model stated under a different
    // spelling matches no cap — which is indistinguishable, from the answer
    // alone, from a model nobody capped. This line is what makes the difference
    // visible. A model id is not content; nothing else about the request is
    // logged.
    debugLog('enforcement: asking about model', request.model);
  }

  return url.toString();
}

/**
 * A decoded body, if it is a decision at all.
 *
 * @param body - Whatever the endpoint returned.
 * @returns The decision, or the reason when the body is not one.
 */
function readDecision(body: unknown): DecisionOutcome {
  const parsed = decisionSchema.safeParse(body);

  if (!parsed.success) {
    debugLog('enforcement: unreadable decision; allowing');

    return { failOpenReason: 'unreadable_response' };
  }

  return { answered: { ...parsed.data, cacheTtlMs: readCacheTtlMs(body) } };
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
