import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CapacityWindow, ProviderCapacityInfo } from "@ai-engine/core";

const MAX_SOURCE_BYTES = 1024 * 1024;
const WINDOWS = [
  { id: "five_hour", label: "5-hour", durationSeconds: 18000 },
  { id: "seven_day", label: "7-day", durationSeconds: 604800 },
  { id: "seven_day_opus", label: "7-day (Opus)", durationSeconds: 604800 },
  { id: "seven_day_sonnet", label: "7-day (Sonnet)", durationSeconds: 604800 },
  { id: "seven_day_oauth_apps", label: "7-day (OAuth apps)", durationSeconds: 604800 }
] as const;

function unknown(detail: string): ProviderCapacityInfo {
  return { status: "unknown", detail };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validReset(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const local = value.slice(0, 19);
  const localMs = Date.parse(`${local}Z`);
  // Date.parse can roll invalid calendar dates into the next month; reject that rollover.
  return Number.isFinite(localMs) && new Date(localMs).toISOString().slice(0, 19) === local && Number.isFinite(Date.parse(value));
}

/**
 * Project only supported capacity fields from the bounded source JSON. The temporary parsed
 * document is never returned, logged, or persisted. No account identifiers, plan inference,
 * spend/credit metadata, or duplicate `limits` entries are copied into the result.
 * fetchedAtMs is Claude's own cache-fetch time, not our file-read time. Cache age and future
 * timestamps are left to the caller's generic evaluator; acquisition has no freshness policy.
 */
export function parseClaudeCapacity(source: string): ProviderCapacityInfo {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) return unknown("Claude capacity source exceeds size limit");
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch {
    return unknown("Claude capacity source is malformed");
  }
  if (!record(document)) return unknown("Claude capacity source is malformed");
  const cache = document.cachedUsageUtilization;
  if (cache === undefined || cache === null) return unknown("Claude capacity observation is absent");
  if (!record(cache)) return unknown("Claude capacity observation is malformed");
  const at = cache.fetchedAtMs;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0 || !Number.isFinite(new Date(at).getTime())) {
    return unknown("Claude capacity observation timestamp is missing or malformed");
  }
  if (!record(cache.utilization)) return unknown("Claude capacity observation is incomplete or malformed");
  const observedAt = new Date(at).toISOString();
  const windows: CapacityWindow[] = [];
  for (const { id, label, durationSeconds } of WINDOWS) {
    const raw = cache.utilization[id];
    if (raw === undefined || raw === null) {
      continue;
    }
    if (!record(raw) || typeof raw.utilization !== "number" || !Number.isFinite(raw.utilization) || raw.utilization < 0) {
      continue;
    }
    if (raw.resets_at !== undefined && raw.resets_at !== null && !validReset(raw.resets_at)) {
      continue;
    }
    windows.push({
      id,
      label,
      durationSeconds,
      usedFraction: raw.utilization / 100,
      observedAt,
      ...(typeof raw.resets_at === "string" ? { resetsAt: raw.resets_at } : {})
    });
  }
  // Known reports contain reliable evidence, not necessarily every supported window.
  return windows.length > 0 ? { status: "known", windows } : unknown("Claude capacity observation has no reliable windows");
}

/** Fixed default provider location, never a repository/config-supplied arbitrary path. */
async function readDefaultSource(): Promise<string> {
  const file = await open(join(homedir(), ".claude.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_SOURCE_BYTES) throw new Error("Unsupported source");
    const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await file.stat();
    if (
      size > MAX_SOURCE_BYTES ||
      size !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("Unstable source");
    }
    return buffer.subarray(0, size).toString("utf8");
  } finally {
    await file.close();
  }
}

/**
 * Passive local read only; never resolves/launches Claude or refreshes its cache. The injectable
 * source function is a test seam, not a configuration option. Returned evidence may be stale or
 * belong to a previously authenticated account; no current-account binding is claimed.
 */
export async function readClaudeCapacity(readSource: () => Promise<string> = readDefaultSource): Promise<ProviderCapacityInfo> {
  try {
    return parseClaudeCapacity(await readSource());
  } catch (error) {
    return unknown(record(error) && error.code === "ENOENT" ? "Claude capacity source is absent" : "Claude capacity source is unreadable");
  }
}
