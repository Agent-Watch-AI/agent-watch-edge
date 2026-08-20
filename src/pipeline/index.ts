/**
 * The package's flows, expressed as ordered lists of named stages rather than
 * as call graphs. The hook path is the one that runs inside the coding agent.
 */
export type { HookPipelineInput, HookPipelineState } from './types/pipeline.types.js';

export { runHookPipeline } from './hook-pipeline.js';
