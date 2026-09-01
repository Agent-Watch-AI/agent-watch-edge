import { describe, expect, it } from 'vitest';
import { normalizeOtlpLogs } from '../src/otlp/normalize.js';

/**
 * The exported `@agent-watch-ai/edge/otlp` helper, held to the same behavior
 * as the platform's own copy in `@agent-watch/otlp`. Provider detection, the
 * completed-request filter and the usage attribute names are the three places
 * the two copies drifted, so those are what these tests pin.
 */

function attribute(key: string, value: string | number | boolean) {
  if (typeof value === 'number') return { key, value: { intValue: String(value) } };

  if (typeof value === 'boolean') return { key, value: { boolValue: value } };

  return { key, value: { stringValue: value } };
}

const ENDED_AT_NANOS = '1786701600000000000';
const RECEIVED_AT = '2026-08-14T10:00:05.000Z';

function logs(records: unknown[]) {
  return { resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ logRecords: records }] }] };
}

/** Gemini CLI's real record, verified against the installed CLI bundle. */
function geminiApiResponse() {
  return {
    timeUnixNano: ENDED_AT_NANOS,
    attributes: [
      attribute('session.id', 'gemini-session-1'),
      attribute('event.name', 'gemini_cli.api_response'),
      attribute('model', 'gemini-2.5-pro'),
      attribute('duration_ms', 1500),
      attribute('input_token_count', 12000),
      attribute('output_token_count', 800),
      attribute('cached_content_token_count', 9000),
      attribute('thoughts_token_count', 450),
      attribute('total_token_count', 13250),
      attribute('prompt_id', 'gemini-session-1########0')
    ]
  };
}

describe('OTLP normalization', () => {
  it('claims a real Gemini api_response and keeps every token count', () => {
    const [call] = normalizeOtlpLogs(logs([geminiApiResponse()]), { receivedAt: RECEIVED_AT });

    expect(call?.provider).toBe('gemini');
    expect(call?.input_tokens).toBe(12000);
    expect(call?.output_tokens).toBe(800);
    // Pricing 12000 input tokens as uncached when 9000 were a cache read is a
    // billing error, not a cosmetic gap.
    expect(call?.cached_input_tokens).toBe(9000);
    expect(call?.reasoning_output_tokens).toBe(450);
    expect(call?.total_tokens).toBe(13250);
  });

  it('binds a Gemini call to the turn it names in prompt_id', () => {
    const [call] = normalizeOtlpLogs(logs([geminiApiResponse()]), { receivedAt: RECEIVED_AT });

    expect(call?.turn_id).toBe('gemini-session-1########0');
    expect(call?.correlation).toBe('turn');
  });

  it('counts the Gemini response half only: the request half carries no usage', () => {
    const apiRequest = {
      timeUnixNano: ENDED_AT_NANOS,
      attributes: [
        attribute('session.id', 'gemini-session-1'),
        attribute('event.name', 'gemini_cli.api_request'),
        attribute('model', 'gemini-2.5-pro'),
        attribute('prompt_id', 'gemini-session-1########0')
      ]
    };

    const calls = normalizeOtlpLogs(logs([apiRequest, geminiApiResponse()]), { receivedAt: RECEIVED_AT });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input_tokens).toBe(12000);
  });

  it('claims a Codex request on its own prefix, without needing a conversation id', () => {
    const record = {
      timeUnixNano: ENDED_AT_NANOS,
      body: { stringValue: 'codex.api_request' },
      attributes: [attribute('model', 'gpt-5-codex'), attribute('input_tokens', 10), attribute('output_tokens', 4)]
    };

    const [call] = normalizeOtlpLogs(logs([record]), { receivedAt: RECEIVED_AT });

    expect(call?.provider).toBe('codex');
    expect(call?.input_tokens).toBe(10);
  });

  it('still requires a session attribute for the generic response.completed name', () => {
    const ambiguous = {
      timeUnixNano: ENDED_AT_NANOS,
      body: { stringValue: 'response.completed' },
      attributes: [attribute('model', 'some-model')]
    };

    expect(normalizeOtlpLogs(logs([ambiguous]), { receivedAt: RECEIVED_AT })).toEqual([]);
  });

  it('keeps Claude working on its documented attribute names', () => {
    const record = {
      timeUnixNano: ENDED_AT_NANOS,
      body: { stringValue: 'claude_code.api_request' },
      attributes: [
        attribute('session.id', 'session-1'),
        attribute('model', 'claude-opus-5'),
        attribute('input_tokens', 120),
        attribute('output_tokens', 30),
        attribute('cache_read_tokens', 900),
        attribute('cost_usd', '0.0123'),
        attribute('request_id', 'req-abc')
      ]
    };

    const [call] = normalizeOtlpLogs(logs([record]), { receivedAt: RECEIVED_AT });

    expect(call?.provider).toBe('claude-code');
    expect(call?.call_id).toBe('req-abc');
    expect(call?.cached_input_tokens).toBe(900);
    expect(call?.cost_usd).toBe(0.0123);
  });

  it('drops a log that is not a provider request', () => {
    const record = {
      timeUnixNano: ENDED_AT_NANOS,
      body: { stringValue: 'claude_code.user_prompt' },
      attributes: [attribute('session.id', 'session-1')]
    };

    expect(normalizeOtlpLogs(logs([record]), { receivedAt: RECEIVED_AT })).toEqual([]);
  });
});
