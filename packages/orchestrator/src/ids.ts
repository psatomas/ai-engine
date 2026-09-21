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
