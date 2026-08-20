/**
 * The command surface. Every command resolves its context once, then works from
 * that value; nothing here reaches for ambient state on its own.
 */
export type { Check, CheckLevel, CliContext, HookRunOptions, ParsedArgs, SetupOptions, UninstallOptions } from './types/cli.types.js';

export { boolFlag, parseArgs, stringFlag } from './args.js';
export { buildCliContext, buildDeliveryStats, buildHookCommand, buildQueue, buildTransport } from './context.js';
export { runHook } from './hook.js';
export { runSetup } from './setup.js';
export { runStatus } from './status.js';
export { runDoctor } from './doctor.js';
export { runUninstall } from './uninstall.js';
export { runAgents, runConfig, runOtelHeaders } from './misc.js';
