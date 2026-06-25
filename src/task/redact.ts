/**
 * Logging hygiene for the LLM tasks.
 *
 * Provider config and prompts routinely carry API keys, tokens, and large or
 * sensitive payloads. These helpers keep secrets out of logs and keep log lines
 * bounded, so attaching a real logger to an agent task is safe by default.
 */

const SECRET_KEY = /(?:api[-_]?key|secret|token|password|passwd|authorization|auth|bearer|credential|private[-_]?key)/i;

const REDACTED = '[redacted]';

/**
 * Deep-clone `value`, masking the values of any keys that look secret. Strings
 * longer than `maxString` are truncated with a length marker. Cycles are
 * collapsed to `[circular]`. Never throws.
 */
export function redact(value: unknown, maxString = 500, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return truncate(value, maxString);
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, maxString, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : redact(v, maxString, seen);
  }
  return out;
}

/** Truncate a string to `max` chars, appending a `(+N more)` marker. */
export function truncate(str: string, max = 500): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max)}… (+${str.length - max} more chars)`;
}

/**
 * A short, log-safe preview of model-bound text: collapses whitespace and
 * truncates. Use for prompts/outputs you want visible at info level without
 * dumping the whole payload.
 */
export function preview(str: string, max = 200): string {
  const collapsed = str.replace(/\s+/g, ' ').trim();
  return truncate(collapsed, max);
}
