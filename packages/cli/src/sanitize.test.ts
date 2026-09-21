import { describe, expect, it } from "vitest";
import { DETAIL_MAX_CHARS, LABEL_MAX_CHARS, sanitizeDisplayText } from "./sanitize.js";

const chr = (code: number): string => String.fromCharCode(code);
const ESC = chr(27);
const BEL = chr(7);
const hasControl = (text: string): boolean =>
  Array.from(text).some((char) => {
    const code = char.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159);
  });
const clean = (text: string, max = 200): string => sanitizeDisplayText(text, max);

describe("sanitizeDisplayText", () => {
  it("exposes the fixed display bounds", () => {
    expect(LABEL_MAX_CHARS).toBe(80);
    expect(DETAIL_MAX_CHARS).toBe(240);
  });

  it.each([
    "plain ascii text",
    "codex:primary",
    "5-hour (Opus) [x]",
    "Claude Code — 5時間 café Ünïcode ✓ 🙂",
    "日本語のラベル",
    "مرحبا بالعالم"
  ])("leaves ordinary Unicode text readable: %s", (text) => {
    expect(clean(text)).toBe(text);
  });

  it("keeps a zero-width joiner sequence intact", () => {
    const family = ["👩", "👩", "👧"].join(chr(0x200d));
    expect(clean(family)).toBe(family);
  });

  describe("terminal escape sequences", () => {
    it.each([
      ["SGR colour", `${ESC}[31mred${ESC}[0m`, "red"],
      ["SGR with parameters", `${ESC}[1;38;5;196mhot${ESC}[m`, "hot"],
      ["clear screen and home", `${ESC}[2J${ESC}[Hclean`, "clean"],
      ["cursor movement", `a${ESC}[10Ab${ESC}[3Cc`, "abc"],
      ["private-mode CSI", `${ESC}[?25lhidden cursor${ESC}[?25h`, "hidden cursor"],
      ["OSC window title ended by BEL", `${ESC}]0;evil title${BEL}visible`, "visible"],
      ["OSC hyperlink ended by ST", `${ESC}]8;;http://evil.example${ESC}\\link${ESC}]8;;${ESC}\\`, "link"],
      ["DCS string ended by ST", `before${ESC}Pq#0;2;0;0;0${ESC}\\after`, "beforeafter"],
      ["APC string ended by ST", `a${ESC}_secret payload${ESC}\\b`, "ab"],
      ["8-bit CSI introducer", `${chr(0x9b)}31mred`, "red"],
      ["two-byte reset sequence", `${ESC}cvisible`, "cvisible"]
    ])("neutralizes %s", (_name, input, expected) => {
      const out = clean(input);
      expect(out).toBe(expected);
      expect(hasControl(out)).toBe(false);
    });

    it("removes an unterminated OSC payload rather than printing it", () => {
      expect(clean(`safe${ESC}]0;never shown`)).toBe("safe");
    });

    it("never lets a lone ESC or a truncated sequence through", () => {
      for (const input of [`a${ESC}`, `${ESC}[`, `${ESC}[31`, `${ESC}${ESC}${ESC}x`, `${ESC}[${ESC}[31mx`]) {
        expect(hasControl(clean(input))).toBe(false);
      }
    });
  });

  describe("output-structure injection", () => {
    it.each([
      ["newline", "first\nsecond", "first second"],
      ["carriage return", "first\rsecond", "first second"],
      ["CRLF", "first\r\nsecond", "first second"],
      ["tab", "first\tsecond", "first second"],
      ["vertical tab and form feed", `first${chr(11)}${chr(12)}second`, "first second"],
      ["a run of mixed line controls", "first\n\r\n\t\nsecond", "first second"],
      ["NEL", `first${chr(0x85)}second`, "first second"],
      ["Unicode line separator", `first${chr(0x2028)}second`, "first second"],
      ["Unicode paragraph separator", `first${chr(0x2029)}second`, "first second"],
      ["a fake continuation line", "name\n    capacity:  known, 99 windows", "name     capacity:  known, 99 windows"]
    ])("collapses %s to a single line", (_name, input, expected) => {
      const out = clean(input);
      expect(out).toBe(expected);
      expect(out).not.toMatch(/[\n\r\t]/);
    });

    it("trims surrounding whitespace", () => {
      expect(clean("  \n padded \t ")).toBe("padded");
    });
  });

  describe("other control characters", () => {
    it("removes NUL, BEL, backspace, DEL and C1 controls", () => {
      const input = `a${chr(0)}b${BEL}c${chr(8)}d${chr(127)}e${chr(0x80)}f${chr(0x9f)}g`;
      expect(clean(input)).toBe("abcdefg");
    });

    it("removes every C0 and C1 control character", () => {
      for (let code = 0; code < 32; code++) expect(hasControl(clean(`x${chr(code)}y`))).toBe(false);
      for (let code = 127; code <= 159; code++) expect(hasControl(clean(`x${chr(code)}y`))).toBe(false);
    });

    it("removes bidirectional override and isolate controls", () => {
      const rlo = chr(0x202e);
      const isolate = chr(0x2066);
      expect(clean(`abc${rlo}def${isolate}ghi`)).toBe("abcdefghi");
    });
  });

  describe("length bound", () => {
    it("leaves a value at exactly the bound untouched", () => {
      expect(clean("x".repeat(10), 10)).toBe("x".repeat(10));
    });

    it("cuts a value one over the bound to exactly the bound, ending in the ellipsis marker", () => {
      const out = clean("x".repeat(11), 10);
      expect(out).toBe(`${"x".repeat(9)}${chr(0x2026)}`);
      expect(Array.from(out)).toHaveLength(10);
    });

    it("bounds a very long value deterministically", () => {
      const out = clean("abcdefghij".repeat(10_000), LABEL_MAX_CHARS);
      expect(Array.from(out)).toHaveLength(LABEL_MAX_CHARS);
      expect(out.endsWith(chr(0x2026))).toBe(true);
      expect(clean("abcdefghij".repeat(10_000), LABEL_MAX_CHARS)).toBe(out);
    });

    it("counts code points, never splitting a surrogate pair", () => {
      const out = clean("🙂".repeat(20), 5);
      expect(Array.from(out)).toHaveLength(5);
      expect(out).toBe(`${"🙂".repeat(4)}${chr(0x2026)}`);
      expect(() => encodeURI(out)).not.toThrow();
    });

    it("bounds the visible result, not the raw input: removed escape sequences do not count", () => {
      const padding = `${ESC}[31m`.repeat(500);
      expect(clean(`a${padding}b`, 5)).toBe("ab");
    });

    it("applies the bound after collapsing whitespace controls", () => {
      expect(clean(`ab${"\n".repeat(50)}cd`, 5)).toBe("ab cd");
    });

    it("keeps the smallest bound meaningful", () => {
      expect(clean("abc", 1)).toBe(chr(0x2026));
      expect(clean("a", 1)).toBe("a");
    });

    it.each([0, -1, 1.5, NaN, Infinity])("rejects an invalid bound %s", (max) => {
      expect(() => sanitizeDisplayText("x", max)).toThrow(RangeError);
    });
  });

  it("coerces a non-string value from an untyped provider rather than crashing the whole command", () => {
    expect(clean(undefined as unknown as string)).toBe("undefined");
    expect(clean(42 as unknown as string)).toBe("42");
  });

  it("returns an empty string for a value made only of removable characters", () => {
    expect(clean(`${ESC}[31m${chr(0)}\n\t`)).toBe("");
  });

  it("is idempotent", () => {
    const hostile = `${ESC}[31mEVIL${ESC}]0;t${BEL}\r\n\tname${chr(0x202e)}${"y".repeat(300)}`;
    const once = clean(hostile, LABEL_MAX_CHARS);
    expect(clean(once, LABEL_MAX_CHARS)).toBe(once);
  });
});
