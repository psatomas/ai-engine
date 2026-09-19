/**
 * Normalized *observed* usage — what AI Engine can actually see a real agent
 * invocation report consuming. This is a record of what happened, and only
 * that: it says nothing about how much provider/account allowance (quota,
 * reset windows, subscription limits) is left, which is a separate question
 * this model deliberately does not answer.
 *
 * Every field is optional on purpose. A provider that doesn't report a
 * dimension (e.g. Claude never reports reasoning tokens separately; Codex
 * usage may be entirely unavailable — see docs/providers.md) must leave it
 * `undefined`, never `0` — a missing metric and a metric that was
 * genuinely zero are different facts, and this contract never conflates them.
 */
export interface ObservedUsage {
  inputTokens?: number;
  /** Tokens served from a prompt cache read (cheaper than a fresh input token, where the provider distinguishes it). */
  cachedInputTokens?: number;
  /** Tokens written to a prompt cache for future reuse. */
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  /** Only ever set for a provider that reports reasoning/thinking tokens as a distinct dimension. */
  reasoningOutputTokens?: number;
  costUsd?: number;
}

/**
 * One fully-attributed record of observed usage for exactly one AI Engine
 * invocation (one `ProviderAdapter.invoke()` call and its resulting
 * `AgentResult`). This is the leaf of the Task -> provider -> role ->
 * invocation hierarchy — task/provider/role totals are always *derived*
 * from a list of these (see `summarizeUsageEvents`/`groupUsageEvents`),
 * never separately maintained, so there is exactly one source of truth and
 * nothing to keep in sync.
 *
 * `role` is the unchanged workflow role (e.g. "implementer"). `operation`
 * is a separate phase/label distinguishing invocations that share a role
 * but mean something different — concretely, `fix()` invokes the same
 * `implementer` role as `implement()`, so `operation` ("implement" vs
 * "fix") is what makes fixer accounting distinguishable without a
 * dedicated workflow role that would exist solely for telemetry.
 */
export interface UsageEvent {
  at: string;
  providerId: string;
  role: string;
  operation: string;
  usage: ObservedUsage;
}

export type UsageTotals = ObservedUsage & { invocations: number };

const USAGE_DIMENSIONS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "costUsd"
] as const satisfies readonly (keyof ObservedUsage)[];

/**
 * Sums each dimension independently across `usages`. A dimension is present
 * in the result iff at least one input defined it — summing only ever
 * combines real reported numbers, and a dimension nothing reported stays
 * absent rather than becoming a fabricated `0`.
 */
export function sumObservedUsage(usages: ObservedUsage[]): ObservedUsage {
  const result: ObservedUsage = {};
  for (const dimension of USAGE_DIMENSIONS) {
    let sum: number | undefined;
    for (const usage of usages) {
      const value = usage[dimension];
      if (value === undefined) continue;
      sum = (sum ?? 0) + value;
    }
    if (sum !== undefined) result[dimension] = sum;
  }
  return result;
}

/**
 * FOUND BY INDEPENDENT REVIEW: some providers (confirmed live for Codex — see
 * packages/providers/src/codex.ts) report usage as a *cumulative* running total for an entire
 * resumed thread, not a delta for the single invocation that produced it. Persisting that raw
 * cumulative number as if it were "what this invocation alone consumed" silently inflates every
 * total for a resumed session — this function is the one place that conversion happens.
 *
 * `current - previous`, computed independently per dimension, exactly like `sumObservedUsage`.
 * A dimension is omitted (never zero, never negative) whenever either side is missing (nothing
 * reliable to subtract) or the subtraction would be negative (a negative delta means the
 * baseline is not trustworthy for that dimension — e.g. a stale/mismatched baseline — and
 * fabricating a result from an unreliable baseline is exactly what this refuses to do). Returns
 * `undefined`, not an all-undefined object, if no dimension could be computed at all — see
 * ObservedUsage's own "unknown, not zero" contract.
 */
export function subtractObservedUsage(current: ObservedUsage, previous: ObservedUsage): ObservedUsage | undefined {
  const result: ObservedUsage = {};
  for (const dimension of USAGE_DIMENSIONS) {
    const c = current[dimension];
    const p = previous[dimension];
    if (c === undefined || p === undefined) continue;
    const delta = c - p;
    if (delta < 0) continue;
    result[dimension] = delta;
  }
  return Object.values(result).some((v) => v !== undefined) ? result : undefined;
}

/** Total observed usage + invocation count across every event given. */
export function summarizeUsageEvents(events: UsageEvent[]): UsageTotals {
  return { ...sumObservedUsage(events.map((e) => e.usage)), invocations: events.length };
}

/**
 * Groups events by an arbitrary key (provider id, role, `${role}:${operation}`,
 * ...) and summarizes each group. Deliberately provider-agnostic: a caller
 * (CLI, future VS Code, future routing policy) picks the grouping without
 * this function — or `UsageEvent` itself — knowing anything about which
 * providers or roles exist.
 */
export function groupUsageEvents(events: UsageEvent[], keyFn: (event: UsageEvent) => string): Record<string, UsageTotals> {
  const groups = new Map<string, UsageEvent[]>();
  for (const event of events) {
    const key = keyFn(event);
    const bucket = groups.get(key);
    if (bucket) bucket.push(event);
    else groups.set(key, [event]);
  }
  const result: Record<string, UsageTotals> = {};
  for (const [key, groupEvents] of groups) result[key] = summarizeUsageEvents(groupEvents);
  return result;
}
