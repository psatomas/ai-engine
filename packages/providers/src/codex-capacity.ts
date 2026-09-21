import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CapacityWindow, ProviderCapacityInfo } from "@ai-engine/core";

/**
 * Hard resource bounds on the passive rollout scan, independent of any one repository's or
 * account's real corpus size — deliberately generous for genuine local usage while remaining a
 * finite ceiling, not an unbounded walk. Mirrors the bounded-traversal posture already
 * established in packages/verification/src/detectors.ts (opendir() streamed, never readdir()
 * materialized, entries capped per directory, directories capped in total).
 */
const MAX_WALK_DEPTH = 6;
const MAX_VISITED_DIRECTORIES = 500;
const MAX_ENTRIES_PER_DIRECTORY = 2000;
/** Total `.jsonl` candidate paths collected before the walk stops, regardless of depth/bounds above. */
const MAX_CANDIDATE_FILES = 200;
/** Of the collected candidates, at most this many are actually opened and read. */
const MAX_FILES_TO_READ = 20;
/**
 * Bytes read from the END of each candidate file, never the whole file. Rollout files are
 * append-only conversation transcripts that can grow into the megabytes; the capacity evidence
 * this reader needs (`token_count` events) is written continuously near the current end of the
 * file, so a bounded tail read finds it without ever materializing transcript content that
 * precedes it. A file whose most recent complete `token_count` line doesn't fit in this window
 * (observed maximum single-line size in real corpora: ~1.8MB) simply contributes no evidence —
 * a safe, tested degradation, never a crash or a fabricated result.
 */
const TAIL_BYTES = 64 * 1024;
/** Caps JSON.parse/record-processing cost even within one byte-bounded tail. */
const MAX_RECORDS_PER_FILE = 500;

/** Recognized bucket windows within one `rate_limits` record. Never assumed complete — new window names must not be rejected structurally. */
const WINDOW_KEYS = ["primary", "secondary"] as const;
type WindowKey = (typeof WINDOW_KEYS)[number];

function unknown(detail: string): ProviderCapacityInfo {
  return { status: "unknown", detail };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * `resets_at` in the rollout wire format is Unix epoch SECONDS (an integer), unlike Claude's
 * ISO-8601 string — confirmed directly against real local rollout evidence (e.g. `1789883712`).
 * Converts to the ISO-8601 string the generic `CapacityWindow.resetsAt` contract requires.
 * Rejects non-finite, non-integer, negative, or unrepresentable values; never rounds/coerces.
 */
function validResetIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return undefined;
  const ms = value * 1000;
  if (!Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toISOString();
}

/** `used_percent` must be a genuine finite, non-negative number. Overage above 100 is preserved, never clamped — same contract Claude's reader already honors. */
function validUsedFraction(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value / 100;
}

/** A short, sane, provider-stated plan token — never inferred, never echoed if it looks unlike a real plan identifier. */
function validPlanLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^[a-z][a-z0-9_]{0,39}$/.test(value) ? value : undefined;
}

interface BucketSnapshot {
  limitId: string;
  limitName?: string;
  planType?: string;
  windows: Partial<Record<WindowKey, CapacityWindow>>;
}

/**
 * Validates one `rate_limits` record's `primary`/`secondary` windows independently — a malformed
 * or absent window is simply missing from the result, never invented, and never invalidates its
 * sibling. `primary` and `secondary` for a given bucket always come from this one record: nothing
 * here ever recombines fields across two different records (see selectSnapshots' doc comment for
 * why that separation is the caller's responsibility, not this function's).
 *
 * `observedAt` is INTENTIONALLY never set on any window this produces — see readCodexCapacity's
 * doc comment for why the rollout format has no defensible observation-time provenance.
 *
 * A window whose `resets_at` is present but malformed drops that whole window (never silently
 * reinterpreted as "no reset"), mirroring parseClaudeCapacity's identical rule; a genuinely
 * absent/null `resets_at` leaves the field unset and the window otherwise valid.
 */
function parseBucketRecord(rec: Record<string, unknown>): BucketSnapshot | undefined {
  const limitId = rec.limit_id;
  if (typeof limitId !== "string" || limitId.length === 0) return undefined;
  const limitName = typeof rec.limit_name === "string" && rec.limit_name.length > 0 ? rec.limit_name : undefined;
  const planType = validPlanLabel(rec.plan_type);

  const windows: Partial<Record<WindowKey, CapacityWindow>> = {};
  for (const key of WINDOW_KEYS) {
    const raw = rec[key];
    if (raw === undefined || raw === null) continue;
    if (!record(raw)) continue;
    const usedFraction = validUsedFraction(raw.used_percent);
    if (usedFraction === undefined) continue;
    if (raw.resets_at !== undefined && raw.resets_at !== null && validResetIso(raw.resets_at) === undefined) continue;
    const resetsAt = raw.resets_at === undefined || raw.resets_at === null ? undefined : validResetIso(raw.resets_at);
    let durationSeconds: number | undefined;
    if (typeof raw.window_minutes === "number" && Number.isFinite(raw.window_minutes) && raw.window_minutes > 0) {
      durationSeconds = raw.window_minutes * 60;
    }
    windows[key] = {
      id: `${limitId}:${key}`,
      ...(limitName ? { label: limitName } : {}),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      usedFraction,
      ...(resetsAt !== undefined ? { resetsAt } : {})
    };
  }
  if (Object.keys(windows).length === 0) return undefined;
  return { limitId, limitName, planType, windows };
}

/**
 * Extracts a bucket snapshot from one JSONL line if — and only if — it is structurally a
 * `{"type":"event_msg","payload":{"type":"token_count","rate_limits":{...}}}` record. Every
 * other shape (including any other event_msg payload type, or a line that fails to parse at
 * all) is silently ignored: a single malformed or unrelated line must never abort scanning the
 * rest of the file, and — critically — this function never touches or returns any field beyond
 * exactly `rate_limits`. Conversation content (prompts, messages, session/account identifiers)
 * is never inspected, copied, or exposed, even transiently.
 */
function parseLine(line: string): BucketSnapshot | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!record(parsed) || parsed.type !== "event_msg") return undefined;
  const payload = parsed.payload;
  if (!record(payload) || payload.type !== "token_count") return undefined;
  const rateLimits = payload.rate_limits;
  if (!record(rateLimits)) return undefined;
  return parseBucketRecord(rateLimits);
}

/**
 * Splits a bounded byte range read from the end of a file into complete JSONL lines only.
 * `truncatedStart` means the read began mid-file (the file is larger than the tail window), so
 * the first split segment is a continuation of a line that started before the captured range and
 * is discarded; a final segment with no trailing newline is a line still being written and is
 * likewise discarded. Neither drop is a correctness bug — at worst it costs one genuine line at
 * either edge of the bounded window, never a mis-parsed or torn one.
 */
function completeLines(tailText: string, truncatedStart: boolean): string[] {
  const endsWithNewline = tailText.endsWith("\n");
  const parts = tailText.split("\n");
  if (!endsWithNewline) parts.pop();
  if (truncatedStart) parts.shift();
  return parts.filter((line) => line.trim().length > 0);
}

interface Candidate {
  path: string;
}

/**
 * One bounded, deterministic, depth-first walk of the Codex sessions directory, collecting
 * `.jsonl` candidate paths. Never follows symlinks (a symlinked entry's `Dirent.isDirectory()`/
 * `isFile()` reflects the link itself, not its target, so both directory and file symlinks are
 * excluded for free — the same property packages/verification/src/detectors.ts relies on).
 * Directory listing is streamed via `opendir()`, never materialized via `readdir()` first, so a
 * pathological directory costs at most MAX_ENTRIES_PER_DIRECTORY reads. Names at each level are
 * sorted descending before recursion: Codex's own `YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`
 * layout sorts lexicographically newest-first under that order, so if any bound truncates the
 * walk, what is already collected is biased toward the most recent evidence — this is the only
 * use filesystem/name ordering ever serves here; it never becomes `CapacityWindow.observedAt`.
 */
async function collectCandidates(root: string): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  let visited = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (candidates.length >= MAX_CANDIDATE_FILES) return;
    if (visited >= MAX_VISITED_DIRECTORIES) return;
    visited++;

    const subdirNames: string[] = [];
    const fileNames: string[] = [];
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      return; // absent/unreadable directory — skip, never fail the whole scan
    }
    try {
      let entryCount = 0;
      for await (const entry of handle) {
        entryCount++;
        if (entryCount > MAX_ENTRIES_PER_DIRECTORY) break; // stop reading further entries — never materializes the rest
        if (entry.isDirectory()) subdirNames.push(entry.name);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) fileNames.push(entry.name);
      }
    } catch {
      return;
    }

    fileNames.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    for (const name of fileNames) {
      if (candidates.length >= MAX_CANDIDATE_FILES) return;
      candidates.push({ path: join(dir, name) });
    }

    if (depth >= MAX_WALK_DEPTH) return;
    subdirNames.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    for (const name of subdirNames) {
      if (candidates.length >= MAX_CANDIDATE_FILES) return;
      await walk(join(dir, name), depth + 1);
    }
  }

  await walk(root, 0);
  return candidates;
}

/**
 * Reads only the last TAIL_BYTES of one candidate file and returns its complete JSONL lines.
 *
 * Deliberately does NOT apply the before/after-stat stability check the Claude reader uses:
 * that check is correct for a small, largely-static config file, but a Codex rollout file is
 * normally being actively appended to by a live session — rejecting it whenever its mtime moves
 * during our read would systematically discard exactly the most valuable (most current) file.
 * What actually matters here is safety, not staticness: the byte range [start, capturedSize) is
 * read at an explicit position, so a concurrent append past capturedSize cannot alter bytes
 * already read, and any line left incomplete at either edge of that fixed range is dropped by
 * completeLines() rather than parsed. Reading is bounded (TAIL_BYTES) regardless of how large the
 * file grows, so an actively-growing file costs no more than a static one of the same tail.
 *
 * Rejects symlinks (O_NOFOLLOW) and non-regular files (explicit isFile() check) exactly like the
 * Claude reader; any I/O error (including a race where the file disappears) yields no lines
 * rather than throwing, so one bad candidate never aborts the rest of the scan.
 */
async function readTailLines(path: string): Promise<string[]> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return [];
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0) return [];
    const size = stat.size;
    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    let readSoFar = 0;
    while (readSoFar < length) {
      const { bytesRead } = await handle.read(buffer, readSoFar, length - readSoFar, start + readSoFar);
      if (!bytesRead) break;
      readSoFar += bytesRead;
    }
    const text = buffer.subarray(0, readSoFar).toString("utf8");
    return completeLines(text, start > 0).slice(0, MAX_RECORDS_PER_FILE);
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Resolves one bucket snapshot per distinct `limit_id`, newest evidence wins, older evidence
 * never backfills or overrides it.
 *
 * `candidates` is already newest-file-first (see collectCandidates); within that order, each
 * file's own tail is scanned in forward (file) order so that, for a given bucket appearing more
 * than once in the same tail, the LAST (most recent within that file) occurrence is kept. Once a
 * `limit_id` has been resolved from an earlier-processed (i.e. newer) file, no later-processed
 * (older) file's snapshot for that same bucket is considered — this is what guarantees stale
 * historical evidence can never override newer evidence, and that duplicate snapshots collapse
 * to one.
 *
 * Different `limit_id` buckets are resolved entirely independently of one another — a "codex"
 * bucket and a "premium" bucket may legitimately come from different files or different moments
 * within a file, exactly like Claude's independently-validated named windows. What this function
 * never does is invent a cross-record relationship: a bucket's own primary/secondary always come
 * from the single record parseBucketRecord read them from, and no attempt is made to guess which
 * records from different bursts "belong together" — reliable multi-bucket reconciliation beyond
 * "each bucket, independently, most recent first" was not established by investigation, so this
 * function deliberately does not attempt it.
 */
async function selectSnapshots(candidates: Candidate[]): Promise<Map<string, BucketSnapshot>> {
  const resolved = new Map<string, BucketSnapshot>();
  for (const candidate of candidates.slice(0, MAX_FILES_TO_READ)) {
    const lines = await readTailLines(candidate.path);
    const perFileLatest = new Map<string, BucketSnapshot>();
    for (const line of lines) {
      const snapshot = parseLine(line);
      if (snapshot) perFileLatest.set(snapshot.limitId, snapshot); // later-in-file overwrites earlier-in-same-file
    }
    for (const [limitId, snapshot] of perFileLatest) {
      if (!resolved.has(limitId)) resolved.set(limitId, snapshot); // never overrides an already-newer bucket
    }
  }
  return resolved;
}

function defaultSessionsRoot(): string {
  return join(homedir(), ".codex", "sessions");
}

/**
 * Acquires Codex capacity passively from local rollout evidence under `sessionsRoot`
 * (default: `~/.codex/sessions`, never a repository/config-supplied arbitrary path — same
 * posture as Claude's fixed `~/.claude.json` source). Performs no Codex process invocation, no
 * network request, no model call, and no app-server RPC — only bounded local file reads.
 *
 * DELIBERATELY NEVER SETS `CapacityWindow.observedAt`. Investigation of the installed Codex
 * protocol/binary found no field, on any locally-available surface, documented or evidenced to
 * mean "this rate-limit snapshot was observed at this instant": the rollout record's own outer
 * timestamp has no such declared semantic, `resets_at` is a reset time not an observation time,
 * and the app-server's synchronous `account/rateLimits/read` response carries no timestamp field
 * at all (only its separate push-notification path does, which requires a persistent app-server
 * connection this passive reader does not make). Fabricating `observedAt` from the rollout
 * timestamp, file mtime, or wall-clock read time would misrepresent evidence that may already be
 * stale by an unknown amount as fresh. Every window this function returns therefore evaluates,
 * under evaluateCapacityWindow, as `freshness: "unknown"` and `usable: false` — correct, and not
 * something this function (or Unit 2) should be changed to avoid.
 *
 * Current-account binding is UNAVAILABLE: rollout files carry no account/user identifier of any
 * kind (only `~/.codex/auth.json`, a wholly separate file, names the current account), so
 * evidence here cannot be structurally or cryptographically confirmed to belong to whichever
 * account is presently authenticated. This is not claimed to be resolved by anything below.
 */
export async function readCodexCapacity(sessionsRoot: string = defaultSessionsRoot()): Promise<ProviderCapacityInfo> {
  // collectCandidates() never rejects: every fallible step inside its own walk() is individually
  // caught and treated as "nothing found at this directory" (see its doc comment), so there is no
  // separate unreadable-source case to sanitize/report here — only "found nothing" below.
  const candidates = await collectCandidates(sessionsRoot);
  if (candidates.length === 0) return unknown("Codex capacity source is absent");

  const resolved = await selectSnapshots(candidates);

  const windows: CapacityWindow[] = [];
  const planTypes = new Set<string>();
  for (const snapshot of resolved.values()) {
    for (const key of WINDOW_KEYS) {
      const window = snapshot.windows[key];
      if (window) windows.push(window);
    }
    if (snapshot.planType) planTypes.add(snapshot.planType);
  }
  if (windows.length === 0) return unknown("Codex capacity observation has no reliable windows");

  // Only surfaced when every contributing bucket agrees; a disagreement is never guessed at.
  const planLabel = planTypes.size === 1 ? [...planTypes][0] : undefined;
  return { status: "known", windows, ...(planLabel ? { account: { planLabel } } : {}) };
}
