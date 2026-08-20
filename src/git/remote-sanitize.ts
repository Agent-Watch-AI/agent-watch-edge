import { sha256Hex } from '../events/event-id.js';
import {
  RE_DOT_GIT_SUFFIX,
  RE_LEADING_SLASHES,
  RE_SCP_REMOTE,
  RE_SCP_USERINFO,
  RE_TRAILING_SLASHES,
  RE_URL_SCHEME,
  RE_URL_USERINFO,
  RE_URL_USERINFO_WITH_PASSWORD
} from './constants/git.constants.js';
import type { RemoteParts } from './types/git.types.js';

/**
 * Strip credentials a remote URL may embed (`https://user:token@host/...`).
 *
 * Runs before anything is stored, hashed or transmitted — a remote is the one
 * piece of git context that routinely carries a live token.
 *
 * @param remote - Raw remote URL as git reports it.
 * @returns The same URL without its userinfo.
 */
export function stripRemoteCredentials(remote: string): string {
  return remote.replace(RE_URL_USERINFO, '$1').replace(RE_URL_USERINFO_WITH_PASSWORD, '$1');
}

/**
 * Canonical `host/org/repo` form of a remote.
 *
 * @param remote - Raw remote URL (https, ssh or scp-like).
 * @returns The normalized identity, or undefined when it cannot be parsed.
 */
export function normalizeRemote(remote: string): string | undefined {
  const stripped = stripRemoteCredentials(remote.trim());
  const parts = isUrlRemote(stripped) ? parseUrlRemote(stripped) : parseScpRemote(stripped);

  if (!parts) return undefined;

  const cleanPath = parts.path.replace(RE_LEADING_SLASHES, '').replace(RE_DOT_GIT_SUFFIX, '').replace(RE_TRAILING_SLASHES, '');

  if (!cleanPath) return undefined;

  return `${parts.host}/${cleanPath}`;
}

/**
 * Stable pseudonymous identifier for a repository.
 *
 * Lets the backend group a repository's activity without being told its name.
 *
 * @param remote - Raw remote URL.
 * @returns Hash of the normalized remote, or undefined when unparseable.
 */
export function remoteHash(remote: string): string | undefined {
  const normalized = normalizeRemote(remote);

  if (!normalized) return undefined;

  return sha256Hex(normalized);
}

/**
 * Whether a remote is scheme-qualified.
 *
 * Branching on "://" rather than on whether `new URL()` throws is deliberate:
 * a userless scp remote ("github.com:org/repo.git") is a *valid* URL whose
 * scheme is the hostname, so a catch-based fallback would never run and the
 * remote would be silently lost.
 *
 * @param remote - Credential-free remote.
 * @returns True when it starts with `scheme://`.
 */
function isUrlRemote(remote: string): boolean {
  return RE_URL_SCHEME.test(remote);
}

/**
 * Host and path of a scheme-qualified remote.
 *
 * @param remote - Remote starting with `scheme://`.
 * @returns Its parts, or undefined when the URL is malformed.
 */
function parseUrlRemote(remote: string): RemoteParts | undefined {
  try {
    const url = new URL(remote);

    if (!url.hostname || !url.pathname) return undefined;

    return { host: url.hostname, path: url.pathname };
  } catch {
    return undefined;
  }
}

/**
 * Host and path of an scp-like remote (`[user@]host:path`).
 *
 * The userinfo is dropped before matching so an embedded password can never
 * reach the result.
 *
 * @param remote - Remote without a scheme.
 * @returns Its parts, or undefined when it is not scp-like.
 */
function parseScpRemote(remote: string): RemoteParts | undefined {
  const match = RE_SCP_REMOTE.exec(remote.replace(RE_SCP_USERINFO, ''));
  const host = match?.[1];
  const remotePath = match?.[2];

  if (!host || !remotePath) return undefined;

  return { host, path: remotePath };
}
