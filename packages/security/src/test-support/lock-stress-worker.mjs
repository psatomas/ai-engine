#!/usr/bin/env node
// Plain JS worker process for TaskLock's cross-process mutual-exclusion stress test (see
// task-lock.test.ts). Deliberately NOT TypeScript: it's spawned as an independent OS process via
// `node <this file>` and imports the already-built class from ../../dist, exactly like a real
// second `ai` invocation or the VS Code extension would use the published package.
//
// This is the regression test for a critical bug found by an independent audit: TaskLock's
// acquire() used to create the lock file and write its content in two separate steps, and
// separately, its stale-lock reclamation deleted whatever was at the lock path unconditionally,
// with no check that it was still the generation just judged stale. Both allowed two processes to
// simultaneously believe they held the same lock under real concurrent contention. Neither bug
// was reachable with only two participants given a head start (which is what earlier tests used) —
// this drives many independent processes at once with no head start, which is what actually
// reproduced them.
import { TaskLock } from "../../dist/task-lock.js";
import { readFile, writeFile } from "node:fs/promises";

const [, , lockPath, counterPath, workerId, iterationsArg, holdMsArg] = process.argv;
const iterations = Number(iterationsArg);
const holdMs = Number(holdMsArg);

const lock = new TaskLock(lockPath, { retries: 200, retryDelayMs: 15 });

async function readCounter() {
  try {
    return JSON.parse(await readFile(counterPath, "utf8"));
  } catch {
    return { inside: 0, violations: 0 };
  }
}
async function writeCounter(c) {
  await writeFile(counterPath, JSON.stringify(c));
}

for (let i = 0; i < iterations; i++) {
  await lock.withLock(async () => {
    // Mutual-exclusion check: increment "inside" on entry, verify nobody else is in, decrement on
    // exit. If the lock is genuinely exclusive, "inside" can never be observed above 1.
    let c = await readCounter();
    c.inside += 1;
    if (c.inside > 1) {
      c.violations = (c.violations ?? 0) + 1;
      process.stderr.write(`worker ${workerId} (pid ${process.pid}): VIOLATION inside=${c.inside}\n`);
    }
    await writeCounter(c);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    c = await readCounter();
    c.inside -= 1;
    await writeCounter(c);
  });
}
