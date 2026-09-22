import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...(await original<typeof import("node:child_process")>()), spawn: mocks.spawn }));
import { launchDetachedWorker } from "./worker-launch.js";
beforeEach(() => mocks.spawn.mockReset());
it("launches Node detached with ignored streams and scrubbed environment; waits only for spawn", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 1234, unref: vi.fn() });
  mocks.spawn.mockReturnValue(child);
  const launched = launchDetachedWorker({
    repoRoot: "/repo",
    taskId: "t-test",
    nonce: "a".repeat(32),
    env: { CLAUDECODE: "1", CLAUDE_CODE_FOO: "x", PATH: "path", AI_ENGINE_MANAGED_TASK: "t-parent" }
  });
  expect(mocks.spawn).toHaveBeenCalledWith(process.execPath, [expect.stringMatching(/worker\.js$/), "t-test", "a".repeat(32)], {
    cwd: "/repo",
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { PATH: "path", AI_ENGINE_MANAGED_TASK: "t-parent" }
  });
  expect(child.unref).not.toHaveBeenCalled();
  child.emit("spawn");
  await expect(launched).resolves.toBe(1234);
  expect(child.unref).toHaveBeenCalledOnce();
});
it("reports a spawn error instead of acknowledging a worker", async () => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  mocks.spawn.mockReturnValue(child);
  const launched = launchDetachedWorker({ repoRoot: "/repo", taskId: "t-test", nonce: "a".repeat(32), env: {} });
  child.emit("error", new Error("spawn failed"));
  await expect(launched).rejects.toThrow("spawn failed");
  expect(child.unref).not.toHaveBeenCalled();
});
