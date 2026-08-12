import { sha256Hex } from '../events/event-id.js';

/**
 * Git remote URLs can embed credentials (https://user:token@host/...).
 * Strip them before anything is stored or transmitted.
 */
export function stripRemoteCredentials(remote: string): string {
  return remote.replace(/^(\w+:\/\/)[^/@\s]+@/, '$1').replace(/^(\w+:\/\/)[^/@\s]+:[^/@\s]+@/, '$1');
}

/** "github.com/org/repo" from https/ssh/scp-like remotes; undefined when unparseable. */
export function normalizeRemote(remote: string): string | undefined {
  const stripped = stripRemoteCredentials(remote.trim());
  let host: string | undefined;
  let pathName: string | undefined;
  // Branch on "://", not on whether new URL() throws: a userless scp remote
  // ("github.com:org/repo.git") is a *valid* URL whose scheme is the hostname,
  // so the catch-based fallback would never run and the remote would be lost.
  if (/^[A-Za-z][\w+.-]*:\/\//.test(stripped)) {
    try {
      const url = new URL(stripped);
      host = url.hostname;
      pathName = url.pathname;
    } catch {
      return undefined;
    }
  } else {
    // scp-like: [user[:password]@]host:path. Drop the whole userinfo before
    // matching so an embedded password can never leak into the result. Two+
    // characters before the colon keeps Windows drive paths ("C:\...") out.
    const scpStripped = stripped.replace(/^[^@/\s]+@/, '');
    const match = scpStripped.match(/^([\w.-]{2,}):([^\s]+)$/);
    if (match) {
      host = match[1];
      pathName = match[2];
    }
  }
  if (!host || !pathName) return undefined;
  const cleanPath = pathName.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!cleanPath) return undefined;
  return `${host}/${cleanPath}`;
}

export function remoteHash(remote: string): string | undefined {
  const normalized = normalizeRemote(remote);
  return normalized ? sha256Hex(normalized) : undefined;
}
