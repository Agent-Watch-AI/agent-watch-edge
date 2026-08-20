/** Protocols a backend URL may use. */
export const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['https:', 'http:']);

/** Prompts the manual provider asks when it has no value yet. */
export const ENDPOINT_PROMPT = 'AgentWatch backend URL: ';
export const TOKEN_PROMPT = 'API token (optional, press Enter to skip): ';

export const RE_TRAILING_SLASHES = /\/+$/;
