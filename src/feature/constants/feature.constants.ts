/**
 * Jira/Linear-style ticket key inside a branch name.
 *
 * Case-sensitive by design: uppercasing the branch first would turn ordinary
 * words into fabricated ticket ids ("bump-node-20" -> NODE-20) and
 * misattribute the session's work and cost to a ticket that does not exist.
 */
export const RE_TICKET_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;

/** Where a candidate was found; carried on the event as provenance. */
export const BRANCH_EVIDENCE_SOURCE = 'git.branch';
