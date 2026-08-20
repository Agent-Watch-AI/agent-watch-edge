/**
 * Antigravity hook payloads: protojson of `exa.hooks_pb.HookArgs`.
 *
 * Verified against the message descriptors compiled into the `agy` binary
 * (`third_party/jetski/hooks_pb/hooks.proto`). Two properties of that schema
 * drive every fixture below, and both differ from every other agent we
 * support:
 *
 * - Identity lives in `common`, never at the top level, and the payload
 *   carries no event-name field at all: the event is whichever `*HookArgs`
 *   oneof member is present.
 * - Tool arguments are PascalCase (`TargetFile`, `CommandLine`), not the
 *   snake_case every other provider uses.
 */

export interface AntigravityCommon {
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  executionId?: string;
  modelName?: string;
  isBattleMode?: boolean;
  lastUserInput?: string;
}

export const ANTIGRAVITY_COMMON: AntigravityCommon = {
  conversationId: 'conv-7f3a',
  workspacePaths: ['/repo'],
  transcriptPath: '/repo/.antigravity/transcript.jsonl',
  artifactDirectoryPath: '/repo/.antigravity/artifacts',
  executionId: 'exec-11',
  modelName: 'Claude Opus 4.6 (Thinking)',
  isBattleMode: false,
  lastUserInput: 'fix the ABC-123 timeout'
};

function withCommon(args: Record<string, unknown>, common: AntigravityCommon = ANTIGRAVITY_COMMON): unknown {
  return { common, ...args };
}

export function antigravitySessionStart(common?: AntigravityCommon): unknown {
  return withCommon({ sessionStartHookArgs: {} }, common);
}

export function antigravityPreInvocation(invocationNum: number, common?: AntigravityCommon): unknown {
  return withCommon({ preInvocationHookArgs: { invocationNum, initialNumSteps: 4 } }, common);
}

export function antigravityPostInvocation(invocationNum: number, modelOutput?: string, common?: AntigravityCommon): unknown {
  return withCommon({ postInvocationHookArgs: { invocationNum, initialNumSteps: 4, modelOutput, modelThinking: 'thinking' } }, common);
}

export function antigravityPreTool(name: string, args: Record<string, unknown>, stepIdx = 3, common?: AntigravityCommon): unknown {
  return withCommon({ preToolHookArgs: { toolCall: { name, args }, stepIdx } }, common);
}

export function antigravityPostTool(
  name: string,
  args: Record<string, unknown>,
  extra: { error?: unknown; result?: unknown; stepIdx?: number } = {},
  common?: AntigravityCommon
): unknown {
  return withCommon(
    {
      postToolHookArgs: {
        stepIdx: extra.stepIdx ?? 3,
        toolCall: { name, args },
        ...(extra.error === undefined ? {} : { error: extra.error }),
        ...(extra.result === undefined ? {} : { result: extra.result })
      }
    },
    common
  );
}

export function antigravityStop(
  extra: { finalModelOutput?: string; fullyIdle?: boolean; terminationReason?: string; error?: unknown; executionNum?: number } = {},
  common?: AntigravityCommon
): unknown {
  return withCommon(
    {
      stopHookArgs: {
        executionNum: extra.executionNum ?? 11,
        fullyIdle: extra.fullyIdle ?? true,
        ...(extra.terminationReason === undefined ? {} : { terminationReason: extra.terminationReason }),
        ...(extra.error === undefined ? {} : { error: extra.error }),
        ...(extra.finalModelOutput === undefined ? {} : { finalModelOutput: extra.finalModelOutput })
      }
    },
    common
  );
}

/** `edit_file` arguments, verbatim key casing. */
export const EDIT_FILE_ARGS = {
  CodeMarkdownLanguage: 'typescript',
  TargetFile: '/repo/src/timeout.ts',
  Instruction: 'raise the timeout',
  Blocking: true,
  CodeEdit: '{{...}}',
  explanation: 'raise the timeout'
};

/** `run_command` arguments, verbatim key casing. */
export const RUN_COMMAND_ARGS = {
  CommandLine: 'npm test',
  Cwd: '/repo',
  Blocking: true,
  WaitMsBeforeAsync: 0,
  explanation: 'run the suite'
};
