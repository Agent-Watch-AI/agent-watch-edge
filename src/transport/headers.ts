import {
  AUTHORIZATION_HEADER,
  INSTALLATION_HEADER,
  USER_AGENT,
  USER_AGENT_HEADER
} from './constants/transport.constants.js';

/**
 * The headers that identify this Edge to the backend, on any route.
 *
 * One place, so the next header the platform requires is added once rather than
 * on every request path — and so a route can never accidentally identify itself
 * differently from the others.
 *
 * @param token - Edge token, when one is configured.
 * @param installationId - This installation's id, when one exists.
 * @returns The header map.
 */
export function edgeHeaders(token?: string, installationId?: string): Record<string, string> {
  return {
    [USER_AGENT_HEADER]: USER_AGENT,
    ...(token ? { [AUTHORIZATION_HEADER]: `Bearer ${token}` } : {}),
    ...(installationId ? { [INSTALLATION_HEADER]: installationId } : {})
  };
}
