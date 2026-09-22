import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { workerEnvironment, type WorkerLaunch } from "@ai-engine/orchestrator";

export async function launchDetachedWorker(input: WorkerLaunch): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./worker.js", import.meta.url)), input.taskId, input.nonce], {
      cwd: input.repoRoot,
      env: workerEnvironment(input.env),
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(child.pid!);
    });
  });
}
