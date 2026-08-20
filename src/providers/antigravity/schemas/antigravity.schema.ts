import { z } from 'zod';

/**
 * Antigravity hook payloads.
 *
 * The payload is protojson of `exa.hooks_pb.HookArgs`
 * (`third_party/jetski/hooks_pb/hooks.proto`, read off the `agy` binary), and it
 * differs from every other agent we support in two ways that no amount of field
 * renaming can paper over:
 *
 * - There is no event-name field. `HookArgs` is a `common` block plus a oneof,
 *   and the event is whichever member of that oneof is set. Reading a
 *   `hookEventName` — a field that exists in no version of this schema — is how
 *   this provider previously produced `agent.other` with no session id for every
 *   hook, which the turn tracker then discarded.
 * - Identity is nested in `common`, and tool arguments are PascalCase
 *   (`TargetFile`, `CommandLine`) rather than the snake_case used elsewhere.
 */

/** proto3 JSON encodes int32 as a number and int64 as a string. */
const protoInt = z.union([z.number(), z.string()]).optional();

const toolCallSchema = z
  .object({
    name: z.string().optional(),
    /** `google.protobuf.Struct`: an arbitrary JSON object. */
    args: z.unknown().optional()
  })
  .passthrough();

const commonSchema = z
  .object({
    conversationId: z.string().optional(),
    workspacePaths: z.array(z.string()).optional(),
    transcriptPath: z.string().optional(),
    artifactDirectoryPath: z.string().optional(),
    executionId: z.string().optional(),
    modelName: z.string().optional(),
    isBattleMode: z.boolean().optional(),
    lastUserInput: z.string().optional()
  })
  .passthrough();

export const antigravityPayloadSchema = z
  .object({
    common: commonSchema.optional(),
    preToolHookArgs: z.object({ toolCall: toolCallSchema.optional(), stepIdx: protoInt }).passthrough().optional(),
    postToolHookArgs: z
      .object({ toolCall: toolCallSchema.optional(), stepIdx: protoInt, error: z.unknown().optional(), result: z.unknown().optional() })
      .passthrough()
      .optional(),
    preInvocationHookArgs: z.object({ invocationNum: protoInt, initialNumSteps: protoInt }).passthrough().optional(),
    postInvocationHookArgs: z
      .object({ invocationNum: protoInt, initialNumSteps: protoInt, modelOutput: z.string().optional(), modelThinking: z.string().optional() })
      .passthrough()
      .optional(),
    stopHookArgs: z
      .object({
        executionNum: protoInt,
        terminationReason: z.string().optional(),
        error: z.unknown().optional(),
        fullyIdle: z.boolean().optional(),
        finalModelOutput: z.string().optional()
      })
      .passthrough()
      .optional(),
    sessionStartHookArgs: z.object({}).passthrough().optional()
  })
  .passthrough();
