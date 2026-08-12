import type { FeatureCandidate } from '../events/canonical-event.js';

const TICKET_PATTERN = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;

/**
 * Extract feature-correlation *evidence* (e.g. Jira/Linear ticket keys) from
 * a branch name. Final feature attribution happens in the backend.
 *
 * Only keys that are uppercase in the branch itself count: uppercasing the
 * whole name first would turn ordinary words into fabricated ticket ids
 * ("bump-node-20" -> NODE-20) and misattribute the session's work and cost.
 */
export function featureCandidatesFromBranch(branch: string | undefined): FeatureCandidate[] {
  if (!branch) return [];
  const candidates: FeatureCandidate[] = [];
  const seen = new Set<string>();
  for (const match of branch.matchAll(TICKET_PATTERN)) {
    const ticket = match[1];
    if (ticket && !seen.has(ticket)) {
      seen.add(ticket);
      candidates.push({ type: 'ticket', value: ticket, source: 'git.branch' });
    }
  }
  return candidates;
}
