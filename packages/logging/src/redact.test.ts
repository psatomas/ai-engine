import { describe, expect, it } from "vitest";
import { redact, redactString } from "./redact.js";

describe("redactString", () => {
  it("masks known secret token shapes", () => {
    expect(redactString("key=sk-abcdefghijklmnopqrstuvwxyz")).toBe("key=[REDACTED]");
    expect(redactString("token ghp_abcdefghijklmnopqrstuvwx")).toBe("token [REDACTED]");
  });

  it("leaves ordinary text untouched", () => {
    expect(redactString("npm run build completed in 1.2s")).toBe("npm run build completed in 1.2s");
  });
});

describe("redact", () => {
  it("masks fields whose key looks secret-shaped", () => {
    const out = redact({ apiKey: "abc", password: "hunter2", note: "fine" }) as Record<string, unknown>;
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.note).toBe("fine");
  });

  it("recurses into nested objects and arrays", () => {
    const out = redact({ nested: { token: "xyz", list: [{ secret: "s" }, { ok: "v" }] } }) as {
      nested: { token: string; list: Array<Record<string, unknown>> };
    };
    expect(out.nested.token).toBe("[REDACTED]");
    expect(out.nested.list[0]?.secret).toBe("[REDACTED]");
    expect(out.nested.list[1]?.ok).toBe("v");
  });

  it("handles circular references without throwing", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => redact(obj)).not.toThrow();
  });
});
