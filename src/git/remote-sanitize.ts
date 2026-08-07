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
  const scpLike = /^(?:[\w.-]+@)?([\w.-]+):(.+)$/;
  let host: string | undefined;
  let pathName: string | undefined;
  try {
    const url = new URL(stripped);
    host = url.hostname;
    pathName = url.pathname;
  } catch {
    const match = stripped.match(scpLike);
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
