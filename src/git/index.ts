/**
 * Where the work happened: repository, branch, commit and dirty files, with
 * remote credentials stripped before anything is stored or sent.
 */
export type { GitContext, GitContextOptions, GitRunner, GitUserEmailOptions, RemoteParts } from './types/git.types.js';
export type { BranchCommit, BranchRef, SnapshotBranch } from './types/snapshot.types.js';

export { collectGitContext, developerIdentity, gitUserEmail, runGit } from './git-context.js';
export { collectBranchCommits, collectBranchRefs, resolveDefaultBranch } from './repo-snapshot.js';
export { normalizeRemote, remoteHash, stripRemoteCredentials } from './remote-sanitize.js';
