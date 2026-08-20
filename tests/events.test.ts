import { describe, expect, it } from 'vitest';
import { deriveEventId, providerEventId, sha256Hex } from '../src/events/event-id.js';
import { featureCandidatesFromBranch } from '../src/feature/ticket-candidates.js';

describe('event ids', () => {
  it('is deterministic for identical inputs', () => {
    const a = deriveEventId({ provider: 'claude', providerEventType: 'PostToolUse', sessionId: 's1', toolUseId: 't1' });
    const b = deriveEventId({ provider: 'claude', providerEventType: 'PostToolUse', sessionId: 's1', toolUseId: 't1' });

    expect(a).toBe(b);
    expect(a).toMatch(/^evt_[0-9a-f]{40}$/);
  });

  it('differs when any identity component differs', () => {
    const base = { provider: 'claude', providerEventType: 'PostToolUse', sessionId: 's1', toolUseId: 't1' };

    expect(deriveEventId(base)).not.toBe(deriveEventId({ ...base, toolUseId: 't2' }));
    expect(deriveEventId(base)).not.toBe(deriveEventId({ ...base, providerEventType: 'PreToolUse' }));
    expect(deriveEventId(base)).not.toBe(deriveEventId({ ...base, provider: 'codex' }));
  });

  it('does not embed raw content', () => {
    const secret = 'super-secret-prompt';
    const id = deriveEventId({ provider: 'claude', providerEventType: 'UserPromptSubmit', payloadFingerprint: sha256Hex(secret) });

    expect(id).not.toContain(secret);
  });

  it('preserves provider ids', () => {
    expect(providerEventId('claude', 'abc')).toBe('evt_claude_abc');
  });
});

describe('feature candidates', () => {
  it('extracts ticket keys from branch names', () => {
    expect(featureCandidatesFromBranch('feature/OASIS-1234-add-auth')).toEqual([
      { type: 'ticket', value: 'OASIS-1234', source: 'git.branch' }
    ]);
  });

  it('keeps only uppercase keys, deduplicated', () => {
    const candidates = featureCandidatesFromBranch('fix/abc-12-and-ABC-12-plus-XY-9');

    expect(candidates.map((candidate) => candidate.value)).toEqual(['ABC-12', 'XY-9']);
  });

  it('does not fabricate tickets from ordinary lowercase words', () => {
    expect(featureCandidatesFromBranch('bump-node-20')).toEqual([]);
    expect(featureCandidatesFromBranch('chore/sha256-2')).toEqual([]);
  });

  it('returns nothing for plain branches', () => {
    expect(featureCandidatesFromBranch('main')).toEqual([]);
    expect(featureCandidatesFromBranch(undefined)).toEqual([]);
  });
});
