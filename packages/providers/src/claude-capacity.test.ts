import { mkdtemp, rm, writeFile, symlink, readFile, mkdir } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateCapacityWindow } from "@ai-engine/core";
import { parseClaudeCapacity, readClaudeCapacity } from "./claude-capacity.js";
import { ClaudeProvider } from "./claude.js";

const testHome = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>())
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => testHome.path
}));
vi.mock("execa", () => ({
  execa: vi.fn(() => {
    throw new Error("Provider process must not be launched");
  })
}));

const at = Date.parse("2026-01-01T00:00:00.000Z");
const reset = "2026-01-02T00:00:00.123456+00:00";
function fixture(overrides: Record<string, unknown> = {}, cacheOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    cachedUsageUtilization: {
      fetchedAtMs: at,
      utilization: {
        five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 74, resets_at: reset },
        ...overrides
      },
      ...cacheOverrides
    }
  });
}

describe("Claude capacity parsing (synthetic evidence)", () => {
  it("maps independent percentage windows, explicit fetch time, zero and nullable resets", () => {
    expect(parseClaudeCapacity(fixture())).toEqual({
      status: "known",
      windows: [
        { id: "five_hour", label: "5-hour", durationSeconds: 18000, usedFraction: 0, observedAt: "2026-01-01T00:00:00.000Z" },
        {
          id: "seven_day",
          label: "7-day",
          durationSeconds: 604800,
          usedFraction: 0.74,
          observedAt: "2026-01-01T00:00:00.000Z",
          resetsAt: reset
        }
      ]
    });
  });

  it.each([0, 25.5, 100, 125])("preserves reported percent %s without clamping", (percent) => {
    const result = parseClaudeCapacity(fixture({ five_hour: { utilization: percent } }));
    expect(result.status).toBe("known");
    if (result.status === "known") expect(result.windows[0]!.usedFraction).toBe(percent / 100);
    expect(result).not.toHaveProperty("remainingFraction");
    expect(result.windows?.[0]).not.toHaveProperty("remainingFraction");
  });

  it.each([undefined, null, "0", true, -1, {}, []])("rejects missing/invalid utilization %s rather than inventing zero", (utilization) => {
    expect(parseClaudeCapacity(fixture({ five_hour: { utilization } })).windows?.map((w) => w.id)).toEqual(["seven_day"]);
  });

  it.each(["1e999", "-1e999"])("rejects non-finite numeric JSON %s", (value) => {
    expect(parseClaudeCapacity(fixture().replace('"utilization":0', `"utilization":${value}`)).windows?.map((w) => w.id)).toEqual([
      "seven_day"
    ]);
  });

  it.each([undefined, null, "bad", [], {}])("preserves sibling evidence for an absent/malformed window %s", (five_hour) => {
    expect(parseClaudeCapacity(fixture({ five_hour })).windows?.map((w) => w.id)).toEqual(["seven_day"]);
  });

  it("rejects invalid JSON even when sibling evidence would otherwise be valid", () => {
    expect(parseClaudeCapacity(fixture().replace('"utilization":0', '"utilization":NaN')).status).toBe("unknown");
  });

  it.each(["five_hour", "seven_day"])("retains the other standard window when %s is absent or malformed", (id) => {
    for (const value of [undefined, null, { utilization: -1 }, { utilization: 10, resets_at: "bad" }]) {
      const result = parseClaudeCapacity(fixture({ [id]: value }));
      expect(result.status).toBe("known");
      expect(result.windows).toEqual(parseClaudeCapacity(fixture()).windows?.filter((w) => w.id !== id));
    }
  });

  it.each(["seven_day_opus", "seven_day_sonnet", "seven_day_oauth_apps"])("handles scoped window %s independently", (id) => {
    for (const value of [{ utilization: -1 }, { utilization: 10, resets_at: "bad" }]) {
      expect(parseClaudeCapacity(fixture({ [id]: value }))).toEqual(parseClaudeCapacity(fixture()));
    }
    for (const five_hour of [undefined, null, { utilization: -1 }, { utilization: 10, resets_at: "bad" }]) {
      expect(parseClaudeCapacity(fixture({ five_hour, seven_day: null, [id]: { utilization: 25, resets_at: reset } }))).toMatchObject({
        status: "known",
        windows: [{ id, usedFraction: 0.25, observedAt: new Date(at).toISOString(), resetsAt: reset }]
      });
    }
  });

  it("returns unknown when all supported windows are absent", () => {
    expect(parseClaudeCapacity(fixture({}, { utilization: {} }))).toEqual({
      status: "unknown",
      detail: "Claude capacity observation has no reliable windows"
    });
    expect(parseClaudeCapacity(fixture({ five_hour: null, seven_day: null })).status).toBe("unknown");
  });

  it("returns unknown when all present windows are malformed", () => {
    expect(
      parseClaudeCapacity(
        fixture({
          five_hour: { utilization: -1 },
          seven_day: { utilization: 20, resets_at: "bad" },
          seven_day_opus: {},
          seven_day_sonnet: [],
          seven_day_oauth_apps: { utilization: null }
        })
      ).status
    ).toBe("unknown");
  });

  it("emits exactly the valid windows from mixed valid, absent and malformed evidence", () => {
    const result = parseClaudeCapacity(
      fixture({
        five_hour: { utilization: 10, resets_at: "bad" },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: 125 },
        seven_day_oauth_apps: { utilization: "25" }
      })
    );
    expect(result.status).toBe("known");
    expect(result.windows).toEqual([
      parseClaudeCapacity(fixture()).windows?.[1],
      {
        id: "seven_day_sonnet",
        label: "7-day (Sonnet)",
        durationSeconds: 604800,
        usedFraction: 1.25,
        observedAt: new Date(at).toISOString()
      }
    ]);
  });

  it("maps only supported scoped windows and never duplicates the generic limits array", () => {
    const result = parseClaudeCapacity(
      fixture({
        seven_day_opus: { utilization: 10, resets_at: reset },
        seven_day_sonnet: { utilization: 20, resets_at: reset },
        seven_day_oauth_apps: { utilization: 30, resets_at: reset },
        limits: [{ kind: "session", percent: 99 }],
        other_quota: { utilization: 99 }
      })
    );
    expect(result.windows?.map((w) => [w.id, w.usedFraction])).toEqual([
      ["five_hour", 0],
      ["seven_day", 0.74],
      ["seven_day_opus", 0.1],
      ["seven_day_sonnet", 0.2],
      ["seven_day_oauth_apps", 0.3]
    ]);
  });

  it("omits absent/null optional windows", () => {
    expect(parseClaudeCapacity(fixture({ seven_day_opus: null })).windows).toHaveLength(2);
  });

  it.each([undefined, null, "123", -1, 1.5, 8640000000000001])("rejects an indefensible fetchedAtMs %s", (fetchedAtMs) => {
    expect(parseClaudeCapacity(fixture({}, { fetchedAtMs })).status).toBe("unknown");
  });

  it.each(["bad", "2026-02-30T00:00:00Z", "2026-01-01", "2026-01-01T24:00:00Z", "2026-01-01T00:00:00+25:00", 123])(
    "does not turn a malformed reset %s into an apparently valid unknown reset",
    (resets_at) => {
      expect(parseClaudeCapacity(fixture({ five_hour: { utilization: 20, resets_at } })).windows?.map((w) => w.id)).toEqual(["seven_day"]);
    }
  );

  it("preserves old/future observations and passed resets for caller-supplied evaluation", () => {
    const result = parseClaudeCapacity(fixture());
    if (result.status !== "known") throw new Error("Expected fixture observation");
    const window = result.windows[1]!;
    expect(evaluateCapacityWindow(window, at + 1000, { maxAgeMs: 1000 }).freshness).toBe("stale");
    expect(evaluateCapacityWindow(window, at - 1, { maxAgeMs: 1000 }).freshness).toBe("invalid");
    expect(evaluateCapacityWindow(window, Date.parse(reset), { maxAgeMs: 1e9 }).reset).toBe("passed");
    expect(window.usedFraction).toBe(0.74);
    expect(window.observedAt).toBe(new Date(at).toISOString());
  });

  it.each(["{", "[]", "null", '{"cachedUsageUtilization":[]}', '{"cachedUsageUtilization":{}}'])(
    "contains malformed sources: %s",
    (source) => {
      expect(parseClaudeCapacity(source).status).toBe("unknown");
    }
  );

  it("distinguishes absent observation from malformed source", () => {
    expect(parseClaudeCapacity("{}")).toEqual({ status: "unknown", detail: "Claude capacity observation is absent" });
    expect(parseClaudeCapacity("{")).toEqual({ status: "unknown", detail: "Claude capacity source is malformed" });
  });

  it("does not copy private fields, infer account labels, or leak parse-error context", () => {
    const sentinel = "PRIVATE_SENTINEL";
    const parsed = JSON.parse(fixture({}, { accountUuid: sentinel, plan: sentinel, planLabel: sentinel }));
    parsed.credentials = sentinel;
    parsed.prompt = sentinel;
    const result = parseClaudeCapacity(JSON.stringify(parsed));
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result).not.toHaveProperty("account");
    expect(JSON.stringify(parseClaudeCapacity(`{${sentinel}`))).not.toContain(sentinel);
  });
});

describe("passive Claude source acquisition", () => {
  beforeEach(async () => {
    testHome.path = await mkdtemp(join(tmpdir(), "ai-engine-capacity-test-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testHome.path, { recursive: true, force: true });
  });

  it("reads the fixed synthetic home source through getCapacity without launching a provider", async () => {
    const path = join(testHome.path, ".claude.json");
    const source = fixture();
    await writeFile(path, source);
    expect(await new ClaudeProvider({ configuredBinaryPath: "/must-not-launch", extraArgs: ["--unused"] }).getCapacity()).toEqual(
      parseClaudeCapacity(source)
    );
    expect(await readFile(path, "utf8")).toBe(source);
  });

  it("returns unknown when the source is absent", async () => {
    expect(await readClaudeCapacity()).toEqual({ status: "unknown", detail: "Claude capacity source is absent" });
  });

  it.each(["EACCES", "EPERM", "EIO"])("contains read failure %s without leaking the path or contents", async (code) => {
    const result = await readClaudeCapacity(async () => {
      throw Object.assign(new Error("PRIVATE_SENTINEL"), { code });
    });
    expect(result).toEqual({ status: "unknown", detail: "Claude capacity source is unreadable" });
  });

  it("rejects symlinks rather than following an arbitrary target", async () => {
    const target = join(testHome.path, "private.json");
    await writeFile(target, fixture());
    await symlink(target, join(testHome.path, ".claude.json"));
    expect((await readClaudeCapacity()).status).toBe("unknown");
  });

  it("rejects non-regular sources", async () => {
    await mkdir(join(testHome.path, ".claude.json"));
    expect((await readClaudeCapacity()).status).toBe("unknown");
  });

  it("bounds oversized sources both on disk and through the parser seam", async () => {
    const source = " ".repeat(1024 * 1024 + 1);
    await writeFile(join(testHome.path, ".claude.json"), source);
    expect((await readClaudeCapacity()).status).toBe("unknown");
    expect(parseClaudeCapacity(source).status).toBe("unknown");
  });

  it("does not cache a previous successful read when the source disappears", async () => {
    const path = join(testHome.path, ".claude.json");
    await writeFile(path, fixture());
    expect((await readClaudeCapacity()).status).toBe("known");
    await rm(path);
    expect((await readClaudeCapacity()).status).toBe("unknown");
  });

  it.each([false, true])("closes a source changed during reading (truncated: %s)", async (truncated) => {
    const content = Buffer.from(fixture());
    const initial = { isFile: () => true, size: content.length, mtimeMs: 1, ctimeMs: 1 };
    const close = vi.fn(async () => {});
    const handle = {
      stat: vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce({ ...initial, mtimeMs: 2 }),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const end = truncated ? content.length - 1 : content.length;
        const bytesRead = content.copy(buffer, offset, position, Math.min(end, position + length));
        return { buffer, bytesRead };
      },
      close
    };
    vi.spyOn(fs, "open").mockResolvedValue(handle as unknown as Awaited<ReturnType<typeof fs.open>>);
    expect(await readClaudeCapacity()).toEqual({ status: "unknown", detail: "Claude capacity source is unreadable" });
    expect(close).toHaveBeenCalledOnce();
  });
});
