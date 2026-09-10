import { RE_TRAILING_SLASHES, ROUTE_FIELDS } from './constants/config.constants.js';
import type { Destination, DestinationTransition } from './types/destination.types.js';

/**
 * Keep enrollment and runtime comparisons on the same base-path convention.
 * @param endpoint - A validated backend base URL.
 * @returns The base used when deriving routes.
 */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(RE_TRAILING_SLASHES, '');
}

/**
 * Missing or refused bases cannot establish that two destinations are safe to share.
 * @param left - Previously configured base.
 * @param right - Proposed base.
 * @returns Whether both usable bases identify the same destination.
 */
export function sameEndpoint(left: string | null | undefined, right: string | null | undefined): boolean {
  return typeof left === 'string' && typeof right === 'string' && normalizeEndpoint(left) === normalizeEndpoint(right);
}

/**
 * Plan one enrollment transition for either a machine or a root. Live routes
 * survive only a known unchanged base; refusals survive until explicitly repaired.
 * Every cleared live route is returned for reporting before the write.
 * @param stored - Explicit routes belonging to the identity being updated.
 * @param previous - Its previous base, including any permitted inheritance.
 * @param endpoint - The validated base selected by enrollment.
 * @returns The route patch and the fields the operator must be told were cleared.
 */
export function transitionDestination(stored: Destination, previous: Destination['endpoint'], endpoint: string): DestinationTransition {
  const unchanged = sameEndpoint(previous, endpoint);
  const routes: DestinationTransition['routes'] = Object.fromEntries(
    ROUTE_FIELDS.map((field) => [field, stored[field] === null || unchanged ? stored[field] : undefined])
  );
  const cleared = ROUTE_FIELDS.filter((field) => typeof stored[field] === 'string' && !unchanged);

  return { routes, cleared };
}
