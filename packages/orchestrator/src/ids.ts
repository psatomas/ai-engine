import { randomBytes } from "node:crypto";

/** Every generated task id starts with this; the managed-context detector keys on it, so it is defined once. */
export const TASK_ID_PREFIX = "t-";

/** Short, sortable, human-writable task ids: t-YYYYMMDDHHMMSS-xxxx. */
export function generateTaskId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);
  const suffix = randomBytes(2).toString("hex");
  return `${TASK_ID_PREFIX}${stamp}-${suffix}`;
}

/**
 * The shape an id must have before it is used to address a task. Generated ids (`t-YYYYMMDDHHMMSS-xxxx`)
 * satisfy it; so does any other id built from letters and digits joined by single hyphens. It exists
 * because the task store builds a file path from the id it is given: an id carrying a path separator,
 * a dot, or anything else outside this set must never reach it.
 */
export const SAFE_TASK_ID = /^t-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
export const SAFE_TASK_ID_MAX_LENGTH = 64;

export function isSafeTaskId(value: unknown): value is string {
  return typeof value === "string" && value.length <= SAFE_TASK_ID_MAX_LENGTH && SAFE_TASK_ID.test(value);
}
