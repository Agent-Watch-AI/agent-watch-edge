export const REDACTED = '[REDACTED]';

/** Key names whose values are always redacted regardless of content. */
export const SENSITIVE_KEY_PATTERN =
  /(^|[_.-])(authorization|auth|token|secret|password|passwd|pwd|credential|credentials|api[_-]?key|apikey|access[_-]?key|private[_-]?key|session[_-]?key|cookie|bearer)([_.-]|$)/i;

interface SecretPattern {
  name: string;
  pattern: RegExp;
  replacement?: string;
}

/** Content patterns for common credentials; applied to every outgoing string. */
export const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { name: 'url-credentials', pattern: /(\w+:\/\/)([^/\s:@]+)(?::([^/\s@]+))?@/g, replacement: `$1${REDACTED}@` },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { name: 'github-fine-grained', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'openai-anthropic-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g },
  { name: 'auth-scheme', pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: `$1 ${REDACTED}` },
  {
    name: 'assignment',
    pattern: /\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret)(\s*[=:]\s*)(["']?)[^\s"'&;]{6,}\3/gi,
    replacement: `$1$2$3${REDACTED}$3`
  }
];
