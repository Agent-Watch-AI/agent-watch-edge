import { describe, expect, it, vi } from 'vitest';
import { MAX_RESPONSE_BYTES } from '../src/transport/constants/transport.constants.js';
import { readCappedJson } from '../src/transport/response-body.js';

/** A response whose body arrives in chunks, declaring no content-length. */
function chunked(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));

      controller.close();
    }
  });

  return new Response(stream, { headers: { 'content-type': 'application/json' } });
}

describe('readCappedJson', () => {
  it('reads a small body, chunked or not', async () => {
    expect(await readCappedJson(new Response('{"accepted":2}'))).toEqual({ accepted: 2 });
    expect(await readCappedJson(chunked(['{"accep', 'ted":3}']))).toEqual({ accepted: 3 });
  });

  it('refuses a body whose declared length is over the cap, without reading it', async () => {
    const response = new Response('{}', { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } });

    await expect(readCappedJson(response)).rejects.toThrow(/too large/);
  });

  it('refuses a chunked body that declares no length and runs past the cap', async () => {
    const chunk = 'x'.repeat(8192);
    const body = chunked(['{"pad":"', ...Array.from({ length: 16 }, () => chunk), '"}']);

    await expect(readCappedJson(body)).rejects.toThrow(/too large/);
  });

  it('rejects a body that is not JSON at all', async () => {
    await expect(readCappedJson(new Response('<html>nope</html>'))).rejects.toThrow();
  });
  it('cancels an oversized declared body without waiting for its producer', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } });

    await expect(readCappedJson(response)).rejects.toThrow(/too large/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it('cancels an oversized stream and releases its reader even if cancellation fails', async () => {
    const cancel = vi.fn(async () => { throw new Error('cleanup failed'); });
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1)); },
      cancel
    }));

    await expect(readCappedJson(response)).rejects.toThrow(/too large/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it('releases the reader after a normal response', async () => {
    const response = chunked(['{"accepted":1}']);

    await expect(readCappedJson(response)).resolves.toEqual({ accepted: 1 });
    expect(response.body?.locked).toBe(false);
  });
});
