import { describe, expect, it } from "vitest";
import { parseMaxAge } from "./max-age.js";

describe("parseMaxAge", () => {
  it.each([
    ["1s", 1000],
    ["30s", 30_000],
    ["15m", 900_000],
    ["2h", 7_200_000],
    ["1d", 86_400_000],
    ["90m", 5_400_000],
    ["365d", 31_536_000_000]
  ])("accepts %s as exactly %d ms", (text, maxAgeMs) => {
    expect(parseMaxAge(text)).toEqual({ maxAgeMs });
  });

  it.each([
    ["zero seconds", "0s"],
    ["zero minutes", "0m"],
    ["zero days", "0d"],
    ["repeated zero", "00s"],
    ["negative", "-5m"],
    ["explicit plus sign", "+5m"],
    ["fractional", "1.5h"],
    ["fractional below one", "0.5m"],
    ["leading decimal point", ".5m"],
    ["trailing decimal point", "5.m"],
    ["unitless", "15"],
    ["unit only", "m"],
    ["empty", ""],
    ["uppercase minute unit", "15M"],
    ["uppercase second unit", "15S"],
    ["uppercase day unit", "1D"],
    ["space before the unit", "15 m"],
    ["trailing space", "15m "],
    ["leading space", " 15m"],
    ["trailing newline", "15m\n"],
    ["leading tab", "\t15m"],
    ["exponent notation", "1e3m"],
    ["hexadecimal", "0x10m"],
    ["leading zero", "05m"],
    ["word unit", "15min"],
    ["milliseconds unit", "15ms"],
    ["unsupported week unit", "1w"],
    ["compound", "15m15s"],
    ["not-a-number", "NaN"],
    ["infinity", "Infinity"],
    ["fullwidth digits", "１５m"],
    ["arbitrary text", "soon"]
  ])("rejects %s (%j)", (_description, text) => {
    // The specific grammar message, so a different failure (e.g. a TypeError from a mis-parsed unit) cannot masquerade as a rejection.
    expect(() => parseMaxAge(text)).toThrow(/^expected a positive whole number followed by s, m, h or d/);
  });

  it("accepts the largest exactly-representable value and rejects the next, without rounding or clamping", () => {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const secondsOk = max / 1000n;
    expect(parseMaxAge(`${secondsOk}s`)).toEqual({ maxAgeMs: Number(secondsOk * 1000n) });
    expect(() => parseMaxAge(`${secondsOk + 1n}s`)).toThrow("too large");

    const daysOk = max / 86_400_000n;
    expect(parseMaxAge(`${daysOk}d`)).toEqual({ maxAgeMs: Number(daysOk * 86_400_000n) });
    expect(() => parseMaxAge(`${daysOk + 1n}d`)).toThrow("too large");
  });

  it.each([`${Number.MAX_SAFE_INTEGER}s`, "99999999999999999999999999999d", `1${"0".repeat(400)}h`])(
    "rejects an unsafe or non-finite conversion %#",
    (text) => {
      expect(() => parseMaxAge(text)).toThrow("too large");
    }
  );

  it("always yields a finite, positive, safe-integer policy that the evaluator accepts", () => {
    for (const text of ["1s", "1m", "1h", "1d", "999999999s"]) {
      const { maxAgeMs } = parseMaxAge(text);
      expect(Number.isSafeInteger(maxAgeMs)).toBe(true);
      expect(maxAgeMs).toBeGreaterThan(0);
    }
  });

  it("returns only the policy: no provider knowledge, no default, no extra fields", () => {
    expect(Object.keys(parseMaxAge("15m"))).toEqual(["maxAgeMs"]);
  });

  it("does not echo rejected input into its error message", () => {
    const hostile = `EVIL${String.fromCharCode(27)}[31mTEXT`;
    try {
      parseMaxAge(hostile);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("EVIL");
      expect((error as Error).message).not.toContain(String.fromCharCode(27));
    }
  });
});
