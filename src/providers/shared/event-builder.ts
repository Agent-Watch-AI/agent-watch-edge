import { compact } from '../../core/object.js';
import type { UnknownRecord } from '../../core/types/core.types.js';
import { EVENT_SCHEMA_VERSION } from '../../events/constants/events.constants.js';
import { deriveEventId } from '../../events/event-id.js';
import type { AgentWatchEvent, EventPatch } from '../../events/types/events.types.js';
import { contentEvidence, extractCommand, extractFilePath } from './tooling.js';
import type { BaseEventInput, CapturePolicy, ToolCallInput } from './types/adapter.types.js';

export type { BaseEventInput, CapturePolicy, ToolCallInput } from './types/adapter.types.js';

/** Metadata key holding the provider's own, non-canonical fields. */
const PROVIDER_METADATA_KEY = 'provider';

/**
 * The part of a canonical event every provider fills in the same way.
 *
 * Adapters build this once and then describe what is *specific* to the hook as
 * a patch, instead of creating an event and editing it field by field. That is
 * what keeps an adapter readable as a mapping table rather than a procedure.
 *
 * @param input - Identity, session scope and provider metadata.
 * @returns The base event.
 */
export function baseEvent(input: BaseEventInput): AgentWatchEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: deriveEventId({
      provider: input.provider,
      providerEventType: input.providerEventType,
      sessionId: input.sessionId,
      turnId: input.turnId,
      toolUseId: input.toolUseId,
      promptId: input.promptId,
      payloadFingerprint: input.payloadFingerprint
    }),
    timestamp: input.timestamp,
    event: { type: input.eventType, providerEventType: input.providerEventType },
    agent: { provider: input.provider, name: input.displayName },
    session: {
      id: input.sessionId,
      providerId: input.sessionId,
      turnId: input.turnId,
      agentId: input.agentId
    },
    ai: input.ai,
    metadata: { [PROVIDER_METADATA_KEY]: compact(input.providerMetadata ?? {}) }
  };
}

/**
 * Combine a base event with what one hook contributed.
 *
 * The nested blocks merge rather than replace — `session`, `ai` and `tool` per
 * field, `metadata` (including its `provider` block) per key — so a patch can
 * add the one field its hook knows about without having to restate the session
 * scope the base already resolved.
 *
 * @param event - The base event.
 * @param patch - Hook-specific fields.
 * @returns A new event carrying both.
 */
export function withPatch(event: AgentWatchEvent, patch: EventPatch): AgentWatchEvent {
  return compact({
    ...event,
    ...patch,
    session: patch.session ? { ...event.session, ...patch.session } : event.session,
    ai: patch.ai ? compact({ ...event.ai, ...patch.ai }) : event.ai,
    tool: patch.tool ? compact({ ...event.tool, ...patch.tool }) : event.tool,
    metadata: mergeMetadata(event.metadata, patch.metadata)
  });
}

/**
 * Merge two metadata bags, merging their `provider` blocks too.
 *
 * @param base - Metadata from the base event.
 * @param extra - Metadata from the patch.
 * @returns The merged bag, or undefined when both were empty.
 */
export function mergeMetadata(base: AgentWatchEvent['metadata'], extra: AgentWatchEvent['metadata']): AgentWatchEvent['metadata'] {
  if (!extra) return base;

  if (!base) return compact(extra as UnknownRecord);

  const baseProvider = base[PROVIDER_METADATA_KEY] as UnknownRecord | undefined;
  const extraProvider = extra[PROVIDER_METADATA_KEY] as UnknownRecord | undefined;
  const merged: UnknownRecord = compact({ ...base, ...extra } as UnknownRecord);

  if (baseProvider || extraProvider) {
    merged[PROVIDER_METADATA_KEY] = compact({ ...baseProvider, ...extraProvider });
  }

  return merged;
}

/**
 * Patch carrying provider-specific metadata only.
 *
 * @param fields - Provider fields; undefined entries are dropped.
 * @returns The patch.
 */
export function providerPatch(fields: UnknownRecord): EventPatch {
  return { metadata: { [PROVIDER_METADATA_KEY]: compact(fields) } };
}

/**
 * Patch for a captured prompt: always its evidence, the text only when the
 * effective config permits it.
 *
 * @param prompt - The prompt text as the agent reported it.
 * @param capture - What the effective config allows.
 * @returns The patch.
 */
export function promptPatch(prompt: string, capture: CapturePolicy): EventPatch {
  return {
    metadata: compact({
      prompt: contentEvidence(prompt),
      promptText: capture.prompts && prompt ? prompt : undefined
    })
  };
}

/**
 * Patch for a captured response: always its evidence, the text only when the
 * effective config permits it.
 *
 * @param response - The response text as the agent reported it.
 * @param capture - What the effective config allows.
 * @returns The patch.
 */
export function responsePatch(response: string, capture: CapturePolicy): EventPatch {
  return {
    metadata: compact({
      response: response ? contentEvidence(response) : undefined,
      responseText: capture.responses && response ? response : undefined
    })
  };
}

/**
 * Patch for a tool call: the canonical `tool` block plus whatever of its
 * input, output and file path the effective config permits.
 *
 * `capture.files` gates every per-file signal, not just Git's changed-file
 * list. The file path is kept absolute here; the enrichment stage relativizes
 * it against the repository root, which is the only place that knows the root.
 *
 * @param call - The tool call.
 * @param capture - What the effective config allows.
 * @returns The patch.
 */
export function toolPatch(call: ToolCallInput, capture: CapturePolicy): EventPatch {
  const isFileTool = call.kind === 'file-read' || call.kind === 'file-edit';
  const filePath = isFileTool ? extractFilePath(call.input) : undefined;

  return {
    tool: compact({ name: call.name, status: call.status, durationMs: call.durationMs }),
    metadata: compact({
      command: call.kind === 'shell' && capture.toolInput ? extractCommand(call.input) : undefined,
      filePath: filePath && capture.files ? filePath : undefined,
      toolInput: capture.toolInput && call.input !== undefined ? call.input : undefined,
      toolOutput: capture.toolOutput && call.output !== undefined ? call.output : undefined,
      error: call.error !== undefined ? contentEvidence(JSON.stringify(call.error)) : undefined,
      [PROVIDER_METADATA_KEY]: compact({ toolUseId: call.toolUseId, ...call.providerFields })
    })
  };
}

/**
 * Patch carrying a file path, when one is known and permitted.
 *
 * For providers whose dedicated file hooks report the path directly instead of
 * inside a tool-input object.
 *
 * @param filePath - The reported path.
 * @param capture - What the effective config allows.
 * @returns The patch, empty when the path is absent or not permitted.
 */
export function filePathPatch(filePath: string | undefined, capture: CapturePolicy): EventPatch {
  if (!filePath || !capture.files) return {};

  return { metadata: { filePath } };
}
