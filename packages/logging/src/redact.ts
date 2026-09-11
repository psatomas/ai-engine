const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|passwd|authorization|bearer|credential|access[_-]?key|private[_-]?key)/i;

// Common secret token shapes we redact even when the surrounding key looks innocuous
// (e.g. a raw key pasted into a free-text "note" field).
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{16,}/g,
  /ghp_[a-zA-Z0-9]{20,}/g,
  /gh[oprsu]_[a-zA-Z0-9]{20,}/g,
  /xox[baprs]-[a-zA-Z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g // JWT-shaped
];

const REDACTED = "[REDACTED]";

export function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** Deep-clones `value`, masking any field whose key looks secret-shaped and scrubbing known secret token shapes from strings. */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((item) => redact(item, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? REDACTED : redact(v, seen);
  }
  return out;
}
