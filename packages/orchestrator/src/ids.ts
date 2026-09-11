import { randomBytes } from "node:crypto";

/** Short, sortable, human-writable task ids: t-YYYYMMDDHHMMSS-xxxx. */
export function generateTaskId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);
  const suffix = randomBytes(2).toString("hex");
  return `t-${stamp}-${suffix}`;
}
