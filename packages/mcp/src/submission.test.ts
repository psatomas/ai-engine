import { expect, it, vi } from "vitest";
import { SubmissionError } from "@ai-engine/orchestrator";
import { getTaskTool, resolveDeps, runGuarded, submitTaskTool } from "./tools.js";
import { fakeApi } from "./test-support/fixtures.js";

it.each(["managed", "indeterminate"] as const)("%s guard precedes submission, state opening and input checking", async (status) => {
  const submit = vi.fn();
  const openTasks = vi.fn();
  const result = await runGuarded(resolveDeps({ detectContext: async () => ({ status }) as never, submit, openTasks }), submitTaskTool, {
    request: ""
  });
  expect(result.structuredContent).toMatchObject({ error: { code: "NESTED_DELEGATION_REFUSED" } });
  expect(submit).not.toHaveBeenCalled();
  expect(openTasks).not.toHaveBeenCalled();
});
it.each(["", " \n", "x".repeat(16385)])("rejects invalid input before submission", async (request) => {
  const submit = vi.fn();
  const result = await runGuarded(resolveDeps({ detectContext: async () => ({ status: "unmanaged" }), submit }), submitTaskTool, {
    request
  });
  expect(result.structuredContent).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  expect(submit).not.toHaveBeenCalled();
});
it("returns bounded submission activity without opening task state", async () => {
  const openTasks = vi.fn();
  const activity = { taskId: "t-new", phase: "CREATING", worker: "starting" } as const;
  const result = await runGuarded(
    resolveDeps({ detectContext: async () => ({ status: "unmanaged" }), submit: async () => activity, openTasks }),
    submitTaskTool,
    { request: "work" }
  );
  expect(result.structuredContent).toMatchObject({ activity });
  expect(openTasks).not.toHaveBeenCalled();
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096);
});
it.each(["DELEGATED_RUN_EXISTS", "WORKER_LAUNCH_FAILED", "DIRTY_WORKING_TREE"] as const)("returns stable %s errors", async (code) => {
  const result = await runGuarded(
    resolveDeps({
      detectContext: async () => ({ status: "unmanaged" }),
      submit: async () => {
        throw new SubmissionError(code, code === "DIRTY_WORKING_TREE" ? { staged: 2, tracked: 1, untracked: 3 } : undefined);
      }
    }),
    submitTaskTool,
    { request: "work" }
  );
  expect(result.structuredContent).toMatchObject({ error: { code } });
  if (code === "DIRTY_WORKING_TREE")
    expect(result.structuredContent).toMatchObject({ error: { counts: { staged: 2, tracked: 1, untracked: 3 } } });
});
it("does not echo unexpected spawn/config/provider errors", async () => {
  const result = await runGuarded(
    resolveDeps({
      detectContext: async () => ({ status: "unmanaged" }),
      reportError: vi.fn(),
      submit: async () => {
        throw new Error("secret /path API_KEY");
      }
    }),
    submitTaskTool,
    { request: "work" }
  );
  expect(result.structuredContent).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  expect(JSON.stringify(result)).not.toMatch(/secret|\/path|API_KEY/);
});
it.each(["CREATING", "RUNNING", "FAILED", "FINISHED"] as const)(
  "get_task exposes durable %s even before a TaskRecord exists",
  async (phase) => {
    const api = { ...fakeApi([]).api, activity: async () => ({ taskId: "t-new", phase, worker: "starting" as const }) };
    const result = await runGuarded(
      resolveDeps({ detectContext: async () => ({ status: "unmanaged" }), openTasks: async () => api }),
      getTaskTool,
      { taskId: "t-new" }
    );
    expect(result.structuredContent).toMatchObject({ activity: { taskId: "t-new", phase } });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).not.toHaveProperty("task");
  }
);
