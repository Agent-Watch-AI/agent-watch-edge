/**
 * The last gate before anything leaves the machine: known credential shapes
 * are removed from every outgoing value, whatever the capture settings.
 */
export type { SecretPattern } from './types/privacy.types.js';

export { REDACTED, SECRET_PATTERNS, SENSITIVE_KEY_PATTERN } from './constants/privacy.constants.js';
export { sanitizeText, sanitizeValue } from './sanitizer.js';
