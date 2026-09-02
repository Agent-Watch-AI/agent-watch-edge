/** Repository context attached to canonical events. */
export interface GitContext {
  readonly repositoryRoot?: string;
  readonly repository?: string;
  readonly remote?: string;
  readonly repositoryHash?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly workingDirectory?: string;
  readonly changedFiles?: readonly string[];
}

export interface GitContextOptions {
  readonly cwd: string;
  readonly includeChangedFiles: boolean;
  readonly timeoutMs?: number;
  readonly maxChangedFiles?: number;
  /**
   * Resolve only the repository root (one git process) and skip
   * branch/commit/remote/status. Hooks on the agent's critical path need the
   * root for path rewriting but none of the expensive details — those are only
   * consumed when a turn closes.
   */
  readonly rootOnly?: boolean;
}

/** Runs one git command and returns its trimmed stdout, or undefined. */
export type GitRunner = (args: readonly string[], cwd: string, timeoutMs: number, home?: string) => Promise<string | undefined>;

export interface GitUserEmailOptions {
  readonly timeoutMs?: number;
  readonly home?: string;
  readonly run?: GitRunner;
}

/** Host and path of a remote, once credentials are stripped. */
export interface RemoteParts {
  readonly host: string;
  readonly path: string;
}

/** Where a gated prompt is happening, when the working copy can say. */
export interface GateCheckout {
  /** Canonical `host/owner/repo`, as `normalizeRemote` produces it. */
  readonly repository: string;
  readonly branch: string;
}

export interface GateCheckoutOptions {
  /** Directory the payload happened in. */
  readonly cwd: string;
  /** Where remembered remotes live; `AgentWatchPaths.checkoutsDir`. */
  readonly checkoutsDir: string;
  readonly timeoutMs?: number;
  /** Clock, injectable for tests. */
  now?(): Date;
  /** Git runner override, injectable for tests. */
  readonly run?: GitRunner;
}
