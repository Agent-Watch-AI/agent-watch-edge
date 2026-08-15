import { describe, expect, it } from 'vitest';
import { alignContentEvidence } from '../src/turns/turn-summary.js';
import { sanitizeValue } from '../src/privacy/sanitizer.js';
import { sha256Hex } from '../src/events/event-id.js';

describe('content evidence alignment', () => {
  it('recomputes evidence from the sanitized, truncated text', () => {
    const longPrompt = `token=super-secret-value ${'x'.repeat(9000)}`;
    const summary = {
      prompt: longPrompt,
      prompt_evidence: { length: longPrompt.length, sha256: sha256Hex(longPrompt) },
      response: 'short answer',
      response_evidence: { length: 12, sha256: sha256Hex('short answer') }
    } as never;

    const sanitized = sanitizeValue(summary) as { prompt: string; response: string };
    const aligned = alignContentEvidence(sanitized as never) as unknown as {
      prompt: string;
      prompt_evidence: { length: number; sha256: string };
      response: string;
      response_evidence: { length: number; sha256: string };
    };

    expect(aligned.prompt.length).toBeLessThanOrEqual(8192);
    expect(aligned.prompt_evidence.length).toBe(aligned.prompt.length);
    expect(aligned.prompt_evidence.sha256).toBe(sha256Hex(aligned.prompt));
    expect(aligned.response_evidence.sha256).toBe(sha256Hex(aligned.response));
  });

  it('keeps capture-time evidence when the text is not transmitted', () => {
    const original = { length: 999, sha256: 'abc' };
    const summary = { prompt_evidence: original } as never;

    const aligned = alignContentEvidence(summary) as unknown as {
      prompt_evidence: { length: number; sha256: string };
    };

    expect(aligned.prompt_evidence).toEqual(original);
  });
});
