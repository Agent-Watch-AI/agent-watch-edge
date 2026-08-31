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
  readonly env: Env;
  readonly paths: AgentWatchPaths;
  readonly config: AgentWatchConfig;
  readonly configState: ConfigLoadResult['state'];
  readonly configError?: string;
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
