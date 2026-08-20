/**
 * Runtime-agnostic primitives: the ambient environment, diagnostics, and the
 * pure helpers every other module composes from.
 */
export type { Env, FlowObserver, FlowResult, FlowTrace, Step, StepOutcome, UnknownRecord } from './types/core.types.js';

export { realEnv } from './env.js';
export { debugEnabled, debugLog, setVerbose, warnLog } from './logger.js';
export { meetsMinVersion, parseVersion } from './version.js';
export { findExecutable } from './which.js';
export { asArray, asRecord, compact, firstNumber, firstString, firstStringOf, isRecord, omitKeys } from './object.js';
export { add, finiteOrZero, sumPresent } from './number.js';
export { pollUntil, sleep } from './async.js';
export { next, pipe, runFlow, step, stop } from './pipe.js';
