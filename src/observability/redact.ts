/**
 * Redaction layer for Langfuse telemetry (OBS-09).
 *
 * Strips secrets and sensitive paths from trace metadata before emission.
 * Uses the same 13 regex patterns as the container PreToolUse secret scanner
 * to ensure consistency.
 */

const HOME_DIR = process.env.HOME || '/Users/unknown';
const HOME_RE = new RegExp(escapeRegex(HOME_DIR), 'g');

/** Secret patterns — same as container/agent-runner/src/index.ts SECRET_PATTERNS */
const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /(?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key|SecretAccessKey)['":\s=]+[A-Za-z0-9/+]{40}/,
  /gh[pousr]_[A-Za-z0-9_]{36,}/,
  /ghp_[A-Za-z0-9]{36}/,
  /xox[bpasr]-[0-9A-Za-z-]+/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /xai-[A-Za-z0-9]{20,}/,
  /['\"]?(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token)['\"]?\s*[:=]\s*['\"][A-Za-z0-9_\-/.+]{20,}['\"]/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /ya29\.[0-9A-Za-z_-]+/,
  /(?:mongodb|postgres|mysql|redis):\/\/[^\s'"]+@[^\s'"]+/,
  /op:\/\/[^\s'"]+/,
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redact a single string value: replace secret patterns and home paths.
 */
export function redactString(value: string): string {
  let result = value;

  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(
      new RegExp(pattern.source, pattern.flags + 'g'),
      '[REDACTED]',
    );
  }

  result = result.replace(HOME_RE, '~');

  return result;
}

/**
 * Deep-walk an object and redact all string values.
 * Returns a new object — does not mutate the original.
 */
export function redactMetadata(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = redactString(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) => {
        if (typeof item === 'string') return redactString(item);
        if (typeof item === 'object' && item !== null) {
          return redactMetadata(item as Record<string, unknown>);
        }
        return item;
      });
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactMetadata(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
