import { asRecord } from '../../core/object.js';
import type { UnknownRecord } from '../../core/types/core.types.js';
import { PAYLOAD_HOOK_EVENT_KEY } from './constants/hook-refusal.constants.js';
import type { ProviderHookResponse } from '../types/provider.types.js';

/**
 * A refusal for the hooks an agent lets a hook refuse, and nothing for the rest.
 *
 * The exit code stays 0 even here: the refusal travels in the protocol's own
 * field, which is what makes it a decision the agent understands rather than a
 * crashed hook. A non-zero exit from a telemetry hook is what invariant 4.1
 * forbids, and it would refuse the turn for the wrong reason.
 *
 * @param payload - Raw hook payload.
 * @param gateEvents - Hooks of this agent that carry a refusal.
 * @param body - The agent's refusal, in its own protocol's fields.
 * @returns The response, or undefined when this hook cannot refuse anything.
 */
export function hookRefusal(payload: unknown, gateEvents: ReadonlySet<string>, body: UnknownRecord): ProviderHookResponse | undefined {
  if (!gateEvents.has(hookEventName(payload) ?? '')) return undefined;

  return { stdout: JSON.stringify(body), exitCode: 0 };
}

/**
 * The hook the agent fired, as the agent names it.
 *
 * Every provider with a JSON hook protocol reports it under the same key; a
 * payload that does not is one no gate applies to.
 *
 * @param payload - Raw hook payload.
 * @returns The provider's own event name, or undefined.
 */
function hookEventName(payload: unknown): string | undefined {
  const reported = asRecord(payload)?.[PAYLOAD_HOOK_EVENT_KEY];

  return typeof reported === 'string' && reported !== '' ? reported : undefined;
}
