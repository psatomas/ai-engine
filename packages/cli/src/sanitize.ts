/** Displayed bound (in Unicode code points) for identifiers and labels. */
export const LABEL_MAX_CHARS = 80;
/** Displayed bound (in Unicode code points) for free-text diagnostic details. */
export const DETAIL_MAX_CHARS = 240;

// U+2026 HORIZONTAL ELLIPSIS. It counts toward the bound, so a cut value is never longer than the bound.
const TRUNCATION_MARKER = "\u2026";

// Terminal escape sequences, matched whole so their payload is removed with them rather than left
// behind as visible text: CSI (ESC [ ... final byte), OSC (ESC ] ... BEL or ESC \), the string
// sequences DCS/SOS/PM/APC (... ESC \), any other two-byte ESC sequence, and the 8-bit CSI introducer.
// An unterminated OSC/string sequence consumes to the end of the value, as a terminal would.
/* eslint-disable no-control-regex -- these patterns exist precisely to match control characters */
const ESCAPE_SEQUENCES =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[PX^_][^\u001b]*(?:\u001b\\)?|\u001b[@-Z\\-_]|\u009b[0-?]*[ -/]*[@-~]/g;
// Line/whitespace controls (including NEL and the Unicode line/paragraph separators) collapse to one
// space so a value can never start a new output line.
const LINE_CONTROLS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
// Every remaining C0/C1 control character, including ESC, BEL, backspace, NUL and DEL.
const OTHER_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
// Bidirectional formatting controls, which can visually reorder surrounding terminal text.
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/* eslint-enable no-control-regex */

/**
 * Make an externally derived string safe to print as one line of terminal output, without touching
 * the value it came from. Escape sequences are removed whole; newline, carriage return, tab and the
 * other whitespace controls collapse to a single space; remaining control and bidi-formatting
 * characters are removed; ordinary Unicode text (including non-Latin scripts and emoji) is left as is.
 * The result is then bounded to `maxChars` Unicode code points, ending in an ellipsis marker when cut.
 *
 * Generic on purpose: it knows nothing about any provider and applies no provider-specific validation.
 */
export function sanitizeDisplayText(value: string, maxChars: number): string {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new RangeError("maxChars must be a positive integer");
  const text = (typeof value === "string" ? value : String(value))
    .replace(ESCAPE_SEQUENCES, "")
    .replace(LINE_CONTROLS, " ")
    .replace(OTHER_CONTROLS, "")
    .replace(BIDI_CONTROLS, "")
    .trim();
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : chars.slice(0, maxChars - 1).join("") + TRUNCATION_MARKER;
}
