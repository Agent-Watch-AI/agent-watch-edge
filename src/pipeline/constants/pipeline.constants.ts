import type { CanonicalEventType } from '../../events/types/events.types.js';

/** Stage names, used in the flow definition and in its debug trace. */
export const STAGE_RESOLVE_CONTEXT = 'resolve-context';
export const STAGE_PARSE_EVENTS = 'parse-events';
export const STAGE_ENFORCE = 'enforce';
export const STAGE_ENRICH = 'enrich';
export const STAGE_TRACK_TURN = 'track-turn';
export const STAGE_DELIVER = 'deliver';

/** Reasons a stage ends the flow early. */
export const STOP_NO_EVENTS = 'provider produced no canonical events';
export const STOP_DRY_RUN = 'dry run: nothing delivered';

/**
 * Canonical event type whose presence makes a payload the turn's gate.
 *
 * Typed as the vocabulary rather than as a bare string: untyped, a typo here
 * type-checks and disables the gate permanently — every allow path is silent by
 * design, so nothing would ever surface it.
 */
export const PROMPT_SUBMITTED_TYPE: CanonicalEventType = 'prompt.submitted';

/** Payload key most agents report their working directory under. */
export const PAYLOAD_CWD_KEY = 'cwd';
