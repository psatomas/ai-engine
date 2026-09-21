import type { CapacityFreshnessPolicy } from "@ai-engine/core";

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
type Unit = keyof typeof UNIT_MS;

/** A canonical positive decimal integer (no sign, decimal point, exponent, padding, or leading zero) and one lowercase unit. */
const GRAMMAR = /^([1-9][0-9]*)([smhd])$/;

/**
 * Parse an explicit `--max-age` freshness limit of the exact form `<int><s|m|h|d>` (e.g. `30s`,
 * `15m`, `2h`, `1d`) into the caller-supplied policy `evaluateCapacityWindow` requires. There is
 * deliberately no default: the caller must supply this, and nothing here knows about any provider.
 *
 * Rejects rather than clamps or rounds: malformed input, zero, and any magnitude whose millisecond
 * value is not exactly representable as a safe integer. The magnitude is converted with BigInt so a
 * huge digit string cannot silently lose precision before that check.
 */
export function parseMaxAge(text: string): CapacityFreshnessPolicy {
  const match = GRAMMAR.exec(text);
  if (!match) {
    throw new Error("expected a positive whole number followed by s, m, h or d (for example 30s, 15m, 2h, 1d), with no spaces or sign");
  }
  const milliseconds = BigInt(match[1]!) * BigInt(UNIT_MS[match[2] as Unit]);
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("duration is too large to represent safely");
  }
  return { maxAgeMs: Number(milliseconds) };
}
