/**
 * Where the work happened: repository, branch, commit and dirty files, with
 * remote credentials stripped before anything is stored or sent.
 */
export type { GitContext, GitContextOptions, GitRunner, GitUserEmailOptions, RemoteParts } from './types/git.types.js';

export { collectGitContext, gitUserEmail } from './git-context.js';
export { normalizeRemote, remoteHash, stripRemoteCredentials } from './remote-sanitize.js';
