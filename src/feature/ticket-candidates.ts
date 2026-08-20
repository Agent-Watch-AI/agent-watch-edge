import type { FeatureCandidate } from '../events/canonical-event.js';
import { BRANCH_EVIDENCE_SOURCE, RE_TICKET_KEY } from './constants/feature.constants.js';

/**
 * Extract feature-correlation *evidence* (Jira/Linear ticket keys) from a
 * branch name.
 *
 * Evidence, not attribution: this reports what the branch name literally
 * contains and the backend decides what it means. Duplicates collapse, order
 * of first appearance is kept.
 *
 * @param branch - Current branch name, or undefined outside a repository.
 * @returns Ticket candidates, empty when the branch names none.
 */
export function featureCandidatesFromBranch(branch: string | undefined): FeatureCandidate[] {
  if (!branch) return [];

  const candidates: FeatureCandidate[] = [];
  const seen = new Set<string>();

  for (const match of branch.matchAll(RE_TICKET_KEY)) {
    const ticket = match[1];

    if (!ticket || seen.has(ticket)) continue;

    seen.add(ticket);
    candidates.push({ type: 'ticket', value: ticket, source: BRANCH_EVIDENCE_SOURCE });
  }

  return candidates;
}
