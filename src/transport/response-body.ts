import { BODY_TOO_LARGE, CONTENT_LENGTH_HEADER, MAX_RESPONSE_BYTES } from './constants/transport.constants.js';

/**
 * Read a small JSON body, refusing one too large to be the answer.
 *
 * Both bodies this guards — the batch's per-event counters and the enforcement
 * decision — are a handful of integers, and both are decoded inside the coding
 * agent's hook process. A compromised, misconfigured or proxy-intercepted
 * endpoint can answer 200 with an arbitrarily large body, and the send timeout
 * bounds the *request*, not the decode: without a cap the hook allocates
 * whatever it is sent.
 *
 * `content-length` is checked first because it is free, and the stream is
 * capped as well because a chunked response declares no length. Throwing is the
 * right failure here: both call sites already treat an unreadable body as "no
 * answer" and fail open.
 *
 * @param response - The response to decode.
 * @returns The parsed body.
 */
export async function readCappedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get(CONTENT_LENGTH_HEADER)) > MAX_RESPONSE_BYTES) {
    discardResponseBody(response);

    throw new Error(BODY_TOO_LARGE);
  }

  return JSON.parse(await readCapped(response));
}

/**
 * Decode a body, giving up once it passes the cap.
 *
 * @param response - The response whose stream to read.
 * @returns The decoded text.
 */
async function readCapped(response: Response): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) return text + decoder.decode();

      total += value.byteLength;

      if (total > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);

        throw new Error(BODY_TOO_LARGE);
      }

      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Release unread responses without making cleanup part of the hook's latency.
 * @param response - A response whose body the caller will not consume.
 * @returns Nothing; cancellation errors cannot affect delivery or enforcement.
 */
export function discardResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}
