import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateCapacityWindow, type CapacityWindow } from "@ai-engine/core";
import { readCodexCapacity } from "./codex-capacity.js";
import { CodexProvider } from "./codex.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>())
}));
vi.mock("execa", () => ({
  execa: vi.fn(() => {
    throw new Error("Provider process must not be launched");
  })
}));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ai-engine-codex-capacity-test-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** A single `token_count` rollout line, defaulting to a realistic well-formed "codex" bucket. */
function tokenCountLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: {
      type: "token_count",
      info: { total_token_usage: { total_tokens: 12345 } },
      rate_limits: {
        limit_id: "codex",
        limit_name: null,
        primary: { used_percent: 42, window_minutes: 300, resets_at: 1789258908 },
        secondary: { used_percent: 11, window_minutes: 10080, resets_at: 1789827687 },
        plan_type: "plus",
        ...overrides
      }
    }
  });
}

async function writeRollout(relativePath: string, lines: string[]): Promise<string> {
  const path = join(root, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, lines.join("\n") + "\n");
  return path;
}

describe("Codex capacity parsing (synthetic rollout evidence)", () => {
  it("maps a single primary window with duration and reset", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [tokenCountLine({ secondary: null })]);
    expect(await readCodexCapacity(root)).toEqual({
      status: "known",
      windows: [{ id: "codex:primary", durationSeconds: 18000, usedFraction: 0.42, resetsAt: "2026-09-13T00:21:48.000Z" }],
      account: { planLabel: "plus" }
    });
  });

  it("maps independent primary + secondary windows from the same bucket record", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [tokenCountLine()]);
    const result = await readCodexCapacity(root);
    expect(result.status).toBe("known");
    expect(result.windows?.map((w) => w.id)).toEqual(["codex:primary", "codex:secondary"]);
    expect(result.windows?.every((w) => w.observedAt === undefined)).toBe(true);
  });

  it("retains multiple independent limit_id buckets as separate windows", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [
      tokenCountLine({ limit_id: "codex" }),
      tokenCountLine({ limit_id: "premium", primary: { used_percent: 5, window_minutes: 300, resets_at: 1789258908 }, secondary: null })
    ]);
    const result = await readCodexCapacity(root);
    expect(result.status).toBe("known");
    expect(result.windows?.map((w) => w.id).sort()).toEqual(["codex:primary", "codex:secondary", "premium:primary"]);
  });

  it.each([0, 50, 100, 150])("preserves reported percent %s without clamping", async (percent) => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [
      tokenCountLine({ primary: { used_percent: percent, window_minutes: 300, resets_at: 1789258908 }, secondary: null })
    ]);
    const result = await readCodexCapacity(root);
    expect(result.status).toBe("known");
    expect(result.windows?.[0]!.usedFraction).toBe(percent / 100);
  });

  it.each([undefined, null, "premium"])("drops an absent/null window %s without discarding its sibling", async (primary) => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [tokenCountLine({ primary })]);
    const result = await readCodexCapacity(root);
    expect(result.status).toBe("known");
    expect(result.windows?.map((w) => w.id)).toEqual(["codex:secondary"]);
  });

  it.each([undefined, null, "42", -1, NaN, Infinity, {}, []])(
    "rejects malformed used_percent %s rather than inventing zero",
    async (used_percent) => {
      await writeRollout("2026/01/01/rollout-a.jsonl", [
        tokenCountLine({ primary: { used_percent, window_minutes: 300, resets_at: 1789258908 } })
      ]);
      const result = await readCodexCapacity(root);
      expect(result.status).toBe("known");
      expect(result.windows?.map((w) => w.id)).toEqual(["codex:secondary"]);
    }
  );

  it("omits only the duration dimension for a malformed window_minutes, keeping the window", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [
      tokenCountLine({ primary: { used_percent: 20, window_minutes: "bad", resets_at: 1789258908 }, secondary: null })
    ]);
    const result = await readCodexCapacity(root);
    expect(result.status).toBe("known");
    expect(result.windows?.[0]).toEqual({ id: "codex:primary", usedFraction: 0.2, resetsAt: "2026-09-13T00:21:48.000Z" });
  });

  it.each(["bad", "1789258908", -1, 1.5, true, {}, []])(
    "drops the whole window on a present-but-malformed resets_at %s rather than treating it as absent",
    async (resets_at) => {
      await writeRollout("2026/01/01/rollout-a.jsonl", [tokenCountLine({ primary: { used_percent: 20, window_minutes: 300, resets_at } })]);
      const result = await readCodexCapacity(root);
      expect(result.status).toBe("known");
      expect(result.windows?.map((w) => w.id)).toEqual(["codex:secondary"]);
    }
  );

  it.each([undefined, null])("leaves resetsAt unset for a genuinely absent reset %s", async (resets_at) => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [
      tokenCountLine({ primary: { used_percent: 20, window_minutes: 300, resets_at }, secondary: null })
    ]);
    const result = await readCodexCapacity(root);
    expect(result.windows?.[0]).not.toHaveProperty("resetsAt");
  });

  it("returns unknown when no windows survive at all", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [tokenCountLine({ primary: null, secondary: null })]);
    expect(await readCodexCapacity(root)).toEqual({ status: "unknown", detail: "Codex capacity observation has no reliable windows" });
  });

  it("ignores malformed shared snapshot structure (rate_limits not an object) without throwing", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: "not-an-object" } })
    ]);
    expect(await readCodexCapacity(root)).toEqual({ status: "unknown", detail: "Codex capacity observation has no reliable windows" });
  });

  it("ignores a missing/empty limit_id record", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [tokenCountLine({ limit_id: "" }), tokenCountLine({ limit_id: undefined })]);
    expect(await readCodexCapacity(root)).toEqual({ status: "unknown", detail: "Codex capacity observation has no reliable windows" });
  });

  it("ignores non-token_count event_msg payloads and unrelated record types", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [
      JSON.stringify({ type: "response_item", content: "hello" }),
      JSON.stringify({ type: "event_msg", payload: { type: "item_completed" } }),
      tokenCountLine({ secondary: null })
    ]);
    const result = await readCodexCapacity(root);
    expect(result.status).toBe("known");
    expect(result.windows?.map((w) => w.id)).toEqual(["codex:primary"]);
  });

  it("skips an unparseable line without discarding a later valid one", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", ["{not valid json", tokenCountLine({ secondary: null })]);
    const result = await readCodexCapacity(root);
    expect(result.status).toBe("known");
    expect(result.windows?.map((w) => w.id)).toEqual(["codex:primary"]);
  });

  it("surfaces plan label only when every contributing bucket agrees", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [
      tokenCountLine({ limit_id: "codex", plan_type: "plus" }),
      tokenCountLine({ limit_id: "premium", plan_type: "go", secondary: null })
    ]);
    const result = await readCodexCapacity(root);
    expect(result.status).toBe("known");
    expect(result.account).toBeUndefined();
  });

  it("rejects a plan_type that does not look like a real plan identifier", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [tokenCountLine({ plan_type: "'; DROP TABLE plans;--" })]);
    const result = await readCodexCapacity(root);
    expect(result.account).toBeUndefined();
  });

  it("never emits observedAt, and Unit 2 evaluates the result as unknown-freshness, unusable", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [tokenCountLine({ secondary: null })]);
    const result = await readCodexCapacity(root);
    expect(result.status).toBe("known");
    const window = result.windows![0]! as CapacityWindow;
    expect(window.observedAt).toBeUndefined();
    expect("observedAt" in window).toBe(false);
    const evaluated = evaluateCapacityWindow(window, Date.now(), { maxAgeMs: 1000 });
    expect(evaluated.freshness).toBe("unknown");
    expect(evaluated.usable).toBe(false);
  });
});

describe("Codex capacity snapshot selection (bounded, newest-first, non-merging)", () => {
  it("keeps primary+secondary of one bucket coherent — never mixes fields across two records", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [
      tokenCountLine({
        primary: { used_percent: 10, window_minutes: 300, resets_at: 1789258908 },
        secondary: { used_percent: 5, window_minutes: 10080, resets_at: 1789827687 }
      }),
      tokenCountLine({ primary: { used_percent: 90, window_minutes: 300, resets_at: 1789258908 }, secondary: null })
    ]);
    const result = await readCodexCapacity(root);
    expect(result.status).toBe("known");
    // The LATEST (last-in-file) record is the one genuinely used, in full: its primary (90%) is
    // reported, and its secondary is genuinely absent from that record — the OLDER record's 5%
    // secondary must never be backfilled in to produce an apparently-more-complete result.
    expect(result.windows?.map((w) => w.id)).toEqual(["codex:primary"]);
    expect(result.windows?.[0]!.usedFraction).toBe(0.9);
  });

  it("does not backfill an older complete snapshot's field into a newer, genuinely partial one", async () => {
    await writeRollout("2026/01/01/rollout-old.jsonl", [
      tokenCountLine({
        primary: { used_percent: 1, window_minutes: 300, resets_at: 1789258908 },
        secondary: { used_percent: 2, window_minutes: 10080, resets_at: 1789827687 }
      })
    ]);
    await writeRollout("2026/01/02/rollout-new.jsonl", [
      tokenCountLine({ primary: { used_percent: 77, window_minutes: 300, resets_at: 1789258908 }, secondary: null })
    ]);
    const result = await readCodexCapacity(root);
    expect(result.status).toBe("known");
    expect(result.windows?.map((w) => w.id)).toEqual(["codex:primary"]);
    expect(result.windows?.[0]!.usedFraction).toBe(0.77);
  });

  it("prefers a newer file's evidence for the same bucket over an older file's, never backfilling", async () => {
    await writeRollout("2026/01/01/rollout-old.jsonl", [
      tokenCountLine({ primary: { used_percent: 5, window_minutes: 300, resets_at: 1789258908 }, secondary: null })
    ]);
    await writeRollout("2026/01/02/rollout-new.jsonl", [
      tokenCountLine({ primary: { used_percent: 95, window_minutes: 300, resets_at: 1789258908 }, secondary: null })
    ]);
    const result = await readCodexCapacity(root);
    expect(result.status).toBe("known");
    expect(result.windows).toHaveLength(1);
    expect(result.windows![0]!.usedFraction).toBe(0.95);
  });

  it("resolves independent buckets from different files without cross-contamination", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [
      tokenCountLine({ limit_id: "codex", primary: { used_percent: 30, window_minutes: 300, resets_at: 1789258908 }, secondary: null })
    ]);
    await writeRollout("2026/01/02/rollout-b.jsonl", [
      tokenCountLine({ limit_id: "premium", primary: { used_percent: 70, window_minutes: 300, resets_at: 1789258908 }, secondary: null })
    ]);
    const result = await readCodexCapacity(root);
    expect(result.status).toBe("known");
    const byId = new Map(result.windows!.map((w) => [w.id, w.usedFraction]));
    expect(byId.get("codex:primary")).toBe(0.3);
    expect(byId.get("premium:primary")).toBe(0.7);
  });

  it("collapses duplicate snapshots for the same bucket across files deterministically", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [
      tokenCountLine({ primary: { used_percent: 50, window_minutes: 300, resets_at: 1789258908 }, secondary: null })
    ]);
    await writeRollout("2026/01/02/rollout-b.jsonl", [
      tokenCountLine({ primary: { used_percent: 50, window_minutes: 300, resets_at: 1789258908 }, secondary: null })
    ]);
    const result = await readCodexCapacity(root);
    expect(result.windows).toHaveLength(1);
  });

  it("keeps the LAST occurrence within a single file's tail for a repeated bucket", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [
      tokenCountLine({ primary: { used_percent: 1, window_minutes: 300, resets_at: 1789258908 }, secondary: null }),
      tokenCountLine({ primary: { used_percent: 2, window_minutes: 300, resets_at: 1789258908 }, secondary: null }),
      tokenCountLine({ primary: { used_percent: 3, window_minutes: 300, resets_at: 1789258908 }, secondary: null })
    ]);
    const result = await readCodexCapacity(root);
    expect(result.windows![0]!.usedFraction).toBe(0.03);
  });

  it("is deterministic across repeated calls against identical evidence", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [tokenCountLine()]);
    await writeRollout("2026/01/02/rollout-b.jsonl", [tokenCountLine({ limit_id: "premium" })]);
    const first = await readCodexCapacity(root);
    const second = await readCodexCapacity(root);
    expect(first).toEqual(second);
  });
});

describe("Codex capacity filesystem/security handling", () => {
  it("returns unknown for an absent sessions directory", async () => {
    expect(await readCodexCapacity(join(root, "does-not-exist"))).toEqual({ status: "unknown", detail: "Codex capacity source is absent" });
  });

  it("skips an unreadable subdirectory without failing the whole scan", async () => {
    const blocked = join(root, "2026", "blocked");
    await mkdir(blocked, { recursive: true });
    await fs.chmod(blocked, 0o000);
    await writeRollout("2026/ok/rollout-a.jsonl", [tokenCountLine({ secondary: null })]);
    try {
      const result = await readCodexCapacity(root);
      expect(result.status).toBe("known");
    } finally {
      await fs.chmod(blocked, 0o700);
    }
  });

  it("rejects a symlinked candidate file rather than following an arbitrary target", async () => {
    // The target lives OUTSIDE the walked tree entirely, so the only possible path to it is via
    // the symlink — if the reader followed the link, it would find real evidence; it must not.
    const outside = await mkdtemp(join(tmpdir(), "ai-engine-codex-capacity-outside-"));
    try {
      const target = join(outside, "private.jsonl");
      await writeFile(target, tokenCountLine({ secondary: null }) + "\n");
      await mkdir(join(root, "2026", "01", "01"), { recursive: true });
      await symlink(target, join(root, "2026", "01", "01", "rollout-a.jsonl"));
      expect(await readCodexCapacity(root)).toEqual({ status: "unknown", detail: "Codex capacity source is absent" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked candidate directory rather than descending into it", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ai-engine-codex-capacity-outside-"));
    try {
      const targetDir = join(outside, "elsewhere");
      await mkdir(targetDir, { recursive: true });
      await writeFile(join(targetDir, "rollout-a.jsonl"), tokenCountLine({ secondary: null }) + "\n");
      await mkdir(join(root, "2026"), { recursive: true });
      await symlink(targetDir, join(root, "2026", "linked"));
      const result = await readCodexCapacity(root);
      expect(result).toEqual({ status: "unknown", detail: "Codex capacity source is absent" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a symlink at open() time even if directory enumeration reported it as a regular file (TOCTOU defense)", async () => {
    // The walk-level check (Dirent.isFile()) already excludes symlinks under normal enumeration,
    // so this test bypasses that layer deliberately: it mocks opendir() to report the candidate
    // as a plain file regardless of what it actually is on disk, isolating the second, independent
    // defense — open()'s O_NOFOLLOW — against a symlink swapped in between enumeration and open
    // (e.g. a directory entry replaced by a symlink after being listed but before being read).
    const outside = await mkdtemp(join(tmpdir(), "ai-engine-codex-capacity-outside-"));
    try {
      const target = join(outside, "private.jsonl");
      await writeFile(target, tokenCountLine({ secondary: null }) + "\n");
      const linkPath = join(root, "rollout-a.jsonl");
      await symlink(target, linkPath);
      const fakeEntry = { name: "rollout-a.jsonl", isDirectory: () => false, isFile: () => true };
      vi.spyOn(fs, "opendir").mockImplementation(async () => {
        async function* iterate() {
          yield fakeEntry;
        }
        return iterate() as unknown as Awaited<ReturnType<typeof fs.opendir>>;
      });
      expect(await readCodexCapacity(root)).toEqual({ status: "unknown", detail: "Codex capacity observation has no reliable windows" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a non-regular candidate (a directory named like a .jsonl file)", async () => {
    await mkdir(join(root, "2026", "01", "01", "rollout-a.jsonl"), { recursive: true });
    expect(await readCodexCapacity(root)).toEqual({ status: "unknown", detail: "Codex capacity source is absent" });
  });

  it("finds evidence within a bounded tail of an oversized file without loading it whole", async () => {
    const path = join(root, "2026", "01", "01", "rollout-a.jsonl");
    await mkdir(join(path, ".."), { recursive: true });
    const filler = "x".repeat(200 * 1024); // well past TAIL_BYTES
    await writeFile(path, `{"padding":"${filler}"}\n` + tokenCountLine({ secondary: null }) + "\n");
    const result = await readCodexCapacity(root);
    expect(result.status).toBe("known");
  });

  it("safely yields no evidence when even the tail window is dominated by one oversized line", async () => {
    const path = join(root, "2026", "01", "01", "rollout-a.jsonl");
    await mkdir(join(path, ".."), { recursive: true });
    const hugeLine = `{"padding":"${"x".repeat(200 * 1024)}"}`;
    await writeFile(path, hugeLine + "\n");
    expect((await readCodexCapacity(root)).status).toBe("unknown");
  });

  it("discards a truncated final line (file still being appended) rather than mis-parsing it", async () => {
    const path = join(root, "2026", "01", "01", "rollout-a.jsonl");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, tokenCountLine({ secondary: null }) + "\n" + '{"type":"event_msg","payload":{"type":"token_count"');
    const result = await readCodexCapacity(root);
    expect(result.status).toBe("known");
    expect(result.windows?.[0]!.usedFraction).toBe(0.42);
  });

  it("discards a truncated leading fragment when the read began mid-file", async () => {
    const path = join(root, "2026", "01", "01", "rollout-a.jsonl");
    await mkdir(join(path, ".."), { recursive: true });
    // A synthetic huge first line pushes the genuine record past the tail-window start boundary,
    // so the capture necessarily begins mid-line; the fragment before the first newline in the
    // captured range must be discarded, not parsed as if it were a complete record.
    const filler = "y".repeat(200 * 1024);
    await writeFile(path, `PARTIALSTART{"padding":"${filler}"}\n` + tokenCountLine({ secondary: null }) + "\n");
    const result = await readCodexCapacity(root);
    expect(result.status).toBe("known");
    expect(JSON.stringify(result)).not.toContain("PARTIALSTART");
  });

  it("does not follow a live-appending file into instability: reading a fixed byte range never throws on concurrent growth", async () => {
    const path = join(root, "2026", "01", "01", "rollout-a.jsonl");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, tokenCountLine({ secondary: null }) + "\n");
    // Simulate a concurrent append landing between this reader's stat() (which captures the byte
    // range to read) and its actual read() of that already-fixed range, by appending for real
    // right after opening the file but before the reader's own read completes.
    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...(args as Parameters<typeof originalOpen>));
      await writeFile(path, '{"type":"response_item","content":"NEW_TURN_WHILE_READING"}\n', { flag: "a" });
      return handle;
    });
    const result = await readCodexCapacity(root);
    // Unaffected: the reader's byte range was fixed before the append landed, so the original
    // "codex" evidence is still found intact, and the reader never throws on the concurrent write.
    expect(result.status).toBe("known");
    expect(result.windows?.[0]!.usedFraction).toBe(0.42);
  });

  it("bounds the number of files actually read even when many candidates exist", async () => {
    for (let i = 0; i < 30; i++) {
      await writeRollout(`2026/01/${String(i).padStart(2, "0")}/rollout-${i}.jsonl`, [
        tokenCountLine({ limit_id: `bucket${i}`, secondary: null })
      ]);
    }
    const result = await readCodexCapacity(root);
    expect(result.status).toBe("known");
    // MAX_FILES_TO_READ caps how many of the 30 candidate files are actually opened.
    expect(result.windows!.length).toBeLessThan(30);
    expect(result.windows!.length).toBeGreaterThan(0);
  });

  it("sanitizes diagnostics: never leaks a raw parser error, path, or transcript content", async () => {
    const sentinel = "PRIVATE_TRANSCRIPT_SENTINEL";
    await writeRollout("2026/01/01/rollout-a.jsonl", [
      JSON.stringify({ type: "response_item", role: "user", content: sentinel }),
      `{not json ${sentinel}`,
      JSON.stringify({
        type: "event_msg",
        payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: null, secondary: null } }
      })
    ]);
    const result = await readCodexCapacity(root);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("never copies session_id, conversation content, or other transcript fields into the result", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          session_id: "SESSION_SENTINEL",
          info: { total_token_usage: { total_tokens: 1 } },
          rate_limits: { limit_id: "codex", primary: { used_percent: 1, window_minutes: 300, resets_at: 1789258908 }, secondary: null }
        }
      })
    ]);
    const result = await readCodexCapacity(root);
    expect(JSON.stringify(result)).not.toContain("SESSION_SENTINEL");
    expect(result.windows).toEqual([
      { id: "codex:primary", durationSeconds: 18000, usedFraction: 0.01, resetsAt: "2026-09-13T00:21:48.000Z" }
    ]);
  });
});

describe("Codex passive capacity acquisition via CodexProvider", () => {
  it("delegates getCapacity() to the passive reader without launching a provider", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [tokenCountLine({ secondary: null })]);
    const provider = new CodexProvider({ configuredBinaryPath: "/must-not-launch" });
    // The provider always reads its own default (~/.codex/sessions), independent of this test's
    // synthetic root; here we only assert the call never spawns a process (execa is mocked to
    // throw) and resolves to a well-formed ProviderCapacityInfo regardless of the real machine's
    // local Codex state.
    const result = await provider.getCapacity();
    expect(result.status === "known" || result.status === "unknown").toBe(true);
    expect(result).not.toHaveProperty("windows.0.observedAt");
  });

  it("readCodexCapacity itself never imports or calls execa", async () => {
    await writeRollout("2026/01/01/rollout-a.jsonl", [tokenCountLine({ secondary: null })]);
    await expect(readCodexCapacity(root)).resolves.toMatchObject({ status: "known" });
  });
});
