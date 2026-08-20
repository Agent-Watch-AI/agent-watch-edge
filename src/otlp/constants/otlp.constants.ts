/**
 * OTLP attribute vocabularies and provider-detection patterns.
 *
 * The names below are the parts most likely to silently disagree with the
 * platform's own copy of this logic (`@agent-watch/otlp`) when the two drift,
 * so they live together in one file rather than being scattered through the
 * normalizer.
 */

/** OTLP/JSON envelope keys. */
export const RESOURCE_LOGS_KEY = 'resourceLogs';
export const SCOPE_LOGS_KEY = 'scopeLogs';
export const LOG_RECORDS_KEY = 'logRecords';

/** Value wrappers proto3 JSON uses for an OTLP AnyValue, in read order. */
export const OTLP_VALUE_KEYS = ['stringValue', 'intValue', 'doubleValue', 'boolValue'] as const;

/** Where an event's name and type may be found. */
export const EVENT_NAME_KEYS = ['event.name', 'name'] as const;
export const EVENT_TYPE_KEYS = ['event.type', 'event.kind', 'type', 'sse_event.type', 'response.type'] as const;

/** Session identity, per provider: Claude only ever uses the dotted form. */
export const CLAUDE_SESSION_KEYS = ['session.id'] as const;
export const GENERIC_SESSION_KEYS = ['conversation.id', 'thread.id', 'session.id'] as const;
export const CODEX_SESSION_KEYS = ['conversation.id', 'thread.id'] as const;
export const THREAD_KEYS = ['thread.id'] as const;

/** Gemini names the turn `prompt_id`; the dotted form is Claude's. */
export const TURN_KEYS = ['prompt.id', 'prompt_id', 'turn.id', 'turn_id'] as const;

export const REQUEST_ID_KEYS = ['request_id', 'request.id', 'response.id', 'response_id', 'client_request_id'] as const;
export const SEQUENCE_KEYS = ['event.sequence', 'sequence'] as const;
export const TIMESTAMP_KEYS = ['event.timestamp', 'timestamp'] as const;
export const MODEL_KEYS = ['model', 'gen_ai.request.model', 'gen_ai.response.model'] as const;
export const DURATION_KEYS = ['duration_ms', 'request.duration_ms', 'codex.api_request.duration_ms'] as const;
export const COST_KEYS = ['cost_usd', 'cost.usd'] as const;
export const ERROR_KEYS = ['error', 'error.message'] as const;
export const BILLING_MODE_KEYS = ['billing_mode', 'auth_mode'] as const;
export const AGENT_ID_KEYS = ['agent_id', 'agent.id', 'subagent.id'] as const;
export const AGENT_TYPE_KEYS = ['query_source', 'agent.name', 'agent.type', 'subagent.type'] as const;
export const PROVIDER_SYSTEM_KEYS = ['gen_ai.system', 'gen_ai.provider.name'] as const;

/**
 * Token-count attribute names, under every name an agent gives them.
 *
 * `cached_content_token_count`, `thoughts_token_count` and `total_token_count`
 * are Gemini's; omitting the first prices a cache read at full input cost.
 */
export const INPUT_TOKEN_KEYS = ['input_tokens', 'input_token_count', 'gen_ai.usage.input_tokens', 'codex.turn.token_usage.input_tokens'] as const;
export const CACHED_INPUT_TOKEN_KEYS = [
  'cache_read_tokens',
  'cached_input_tokens',
  'cached_input_token_count',
  'cached_content_token_count',
  'gen_ai.usage.cache_read.input_tokens'
] as const;
export const CACHE_CREATION_TOKEN_KEYS = ['cache_creation_tokens', 'cache_write_input_tokens', 'gen_ai.usage.cache_write.input_tokens'] as const;
export const OUTPUT_TOKEN_KEYS = ['output_tokens', 'output_token_count', 'gen_ai.usage.output_tokens', 'codex.turn.token_usage.output_tokens'] as const;
export const REASONING_TOKEN_KEYS = [
  'reasoning_output_tokens',
  'reasoning_token_count',
  'thoughts_token_count',
  'codex.usage.reasoning_output_tokens'
] as const;
export const TOTAL_TOKEN_KEYS = ['total_tokens', 'total_token_count', 'codex.usage.total_tokens', 'codex.turn.token_usage.total_tokens'] as const;

/** Log-record fields read directly rather than from attributes. */
export const TRACE_ID_KEYS = ['traceId'] as const;
export const SPAN_ID_KEYS = ['spanId'] as const;
export const TIME_NANO_KEYS = ['timeUnixNano', 'observedTimeUnixNano'] as const;

/** Provider-detection patterns. */
export const RE_CODEX_EVENT = /codex[._](sse_event|api_request)/;
export const RE_RESPONSE_COMPLETED = /response\.completed/;
export const RE_CLAUDE_EVENT = /claude_code[._](api_request|llm_request)/;
export const RE_GEMINI_EVENT = /gemini[._\w]*[._](api_request|api_response|api_error|llm_request)|gemini_code/;
export const RE_API_REQUEST = /api_request/;
export const RE_CODEX_COMPLETED = /codex[._]api_request|response\.completed/;
export const RE_GEMINI_COMPLETED = /api_response|api_error|generate_content|generateContent|response\.completed/;

/**
 * `gen_ai.system` / `gen_ai.provider.name` values that mean Gemini.
 *
 * Gemini CLI's real event names are `gemini_cli.api_request`,
 * `gemini_cli.api_response` and `gemini_cli.api_error`, and the attribute that
 * names the provider is `gen_ai.provider.name` (`gcp.gen_ai` / `gcp.vertex_ai`),
 * never `gen_ai.system`.
 */
export const GEMINI_SYSTEM_VALUES: ReadonlySet<string> = new Set(['gemini', 'gcp.gen_ai', 'gcp.vertex_ai']);

/** Public provider label per detected internal provider. */
export const CANONICAL_PROVIDER_NAMES: Readonly<Record<string, string>> = {
  claude: 'claude-code',
  codex: 'codex',
  gemini: 'gemini'
};

/** Default surface when correlation supplies none. */
export const DEFAULT_SURFACE = 'cli';

/** Prefix on a call id we had to derive ourselves. */
export const DERIVED_CALL_ID_PREFIX = 'derived_';

/** Hex characters kept from a derived call id's digest. */
export const DERIVED_CALL_ID_HEX_LENGTH = 40;

/** Nanoseconds per millisecond, for OTLP timestamps. */
export const NANOS_PER_MILLI = 1_000_000n;

/** proto3 JSON encodes an unset uint64 as the string "0". */
export const UNSET_TIME_VALUES: ReadonlySet<string | number> = new Set<string | number>(['0', 0]);

/** OTLP/HTTP signals the example receiver serves. */
export const OTLP_HTTP_SIGNALS = ['logs', 'traces', 'metrics'] as const;

/** The only OTLP/HTTP routes the example receiver answers on. */
export const RE_OTLP_HTTP_PATH = /^\/v1\/otlp\/v1\/(logs|traces|metrics)$/;
