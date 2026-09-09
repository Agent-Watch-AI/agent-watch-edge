import type { AgentWatchConfig, ConfigLoadResult } from '../../config/types/config.types.js';
import type { Env } from '../../core/types/core.types.js';
import type { GitRunner } from '../../git/types/git.types.js';
import type { AgentWatchPaths, InstallState } from '../../storage/types/storage.types.js';

/** Parsed argv. */
export interface ParsedArgs {
  readonly command?: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

/** Everything a command needs, resolved once at its start. */
export interface CliContext {
  readonly disabled: boolean;
  readonly env: Env;
  readonly paths: AgentWatchPaths;
  /**
   * The machine's global config, `roots` included. What `setup`, `uninstall`
   * and `toggle` read and write: the file on disk is machine-wide.
   */
  readonly config: AgentWatchConfig;
  /**
   * The same config with the matching `roots[]` entry applied for `env.cwd` —
   * the identity the hooks in this directory actually send as.
   *
   * Everything partitioned by identity is built from this and never from
   * `config`: the queue, the loss tally, the credential block and the
   * transport. The hook path resolves its identity through `applyRootOverride`,
   * so a command reading the global token would look at another partition's
   * files — reporting an empty backlog for a root that has one, and probing,
   * blocking and unblocking a credential that is not the one being refused.
   */
  readonly identityConfig: AgentWatchConfig;
  /** The `roots[]` path that produced `identityConfig`, when one matched. */
  readonly identityRoot?: string;
  readonly configState: ConfigLoadResult['state'];
  readonly configError?: string;
  /** Fields the load accepted the file without — a URL nothing may be sent to. */
  readonly configWarnings: readonly string[];
  readonly installState: InstallState;
}

export interface HookRunOptions {
  readonly env: Env;
  /** Raw stdin payload; tests inject a string instead of reading process.stdin. */
  readonly input?: string;
  readonly dryRun?: boolean;
  readonly writeStdout?: (text: string) => void;
}

export interface SetupOptions {
  readonly env: Env;
  readonly setupUrl?: string;
  readonly endpoint?: string;
  readonly token?: string;
  /** Developer identity for turn summaries; falls back to `git config user.email`. */
  readonly developerEmail?: string;
  /**
   * Absolute project root to file this identity under, instead of making it the
   * machine's default. This is what lets one machine report to two tenants.
   */
  readonly root?: string;
  /** OTLP signal selection: "all", "none" or a comma list of logs,traces,metrics. */
  readonly otel?: string;
  /** Non-interactive: fail instead of prompting. */
  readonly yes?: boolean;
  readonly ask?: (question: string) => Promise<string>;
  readonly hookCommandFor?: (providerId: string) => string;
  /** Git runner override; tests resolve the identity without a real git. */
  readonly gitRun?: GitRunner;
}

/** What `agentwatch doctor` was asked to report. */
export interface DoctorOptions {
  /** Emit machine-readable JSON instead of the human report. */
  readonly json?: boolean;
  /** Git runner override; tests resolve the identity without a real git. */
  readonly gitRun?: GitRunner;
}

export interface UninstallOptions {
  readonly env: Env;
  readonly agent?: string;
  /** Also delete local config, queue and state. Off by default. */
  readonly purge?: boolean;
}

/** Severity of one doctor finding. */
export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface Check {
  readonly name: string;
  readonly level: CheckLevel;
  readonly detail?: string;
}

/** Terminal symbols, one per level. */
export interface LevelSymbols {
  readonly ok: string;
  readonly warn: string;
  readonly fail: string;
  readonly off: string;
}
