import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { detectManagedContext, TASK_VIEW_LIMITS, type ManagedContext } from "@ai-engine/orchestrator";
import {
  MAX_GET_TASK_RESPONSE_BYTES,
  MAX_LIST_TASKS_RESPONSE_BYTES,
  TOOLS,
  TOOL_ERRORS,
  createTaskMcpServer,
  listTasksTool,
  runGuarded,
  type TaskMcpDeps
} from "./index.js";
import { successResult } from "./results.js";
import { resolveDeps } from "./tools.js";
import { connectInProcess, type RpcClient, type RpcResponse } from "./test-support/rpc.js";
import { OTHER_REPO_ROOT, REPO_ROOT, WORKTREE, fakeApi, makeTask, planTask } from "./test-support/fixtures.js";

const MARKER_VALUE = "SECRET-MARKER-VALUE-123";
let scratch: string;
let dataDir: string;
let plainDir: string;
let taskWorktree: string;
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ AI_ENGINE_DATA_DIR: dataDir, ...extra });

const contexts = {
  unmanaged: () => detectManagedContext({ cwd: plainDir, env: env() }),
  marker: () => detectManagedContext({ cwd: plainDir, env: env({ AI_ENGINE_MANAGED_TASK: MARKER_VALUE }) }),
  path: () => detectManagedContext({ cwd: join(dataDir, "worktrees", "t-x"), env: env() }),
  topology: () => detectManagedContext({ cwd: taskWorktree, env: env() }),
  indeterminate: () => detectManagedContext({ cwd: join(scratch, "gone"), env: env() })
} as const;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "ai-engine-mcp-"));
  dataDir = join(scratch, "data");
  plainDir = join(scratch, "plain");
  mkdirSync(join(dataDir, "worktrees", "t-x"), { recursive: true });
  mkdirSync(plainDir);
  // A real linked worktree on a task branch, deliberately OUTSIDE the configured worktrees root.
  const repo = join(scratch, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--initial-branch=main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "f"), "x\n");
  git("add", ".");
  git("commit", "-m", "init");
  taskWorktree = join(scratch, "custom-worktrees", "t-20260101000000-abcd");
  git("worktree", "add", "-b", "ai/t-20260101000000-abcd", taskWorktree);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let opened: RpcClient[] = [];
afterEach(async () => {
  await Promise.all(opened.map((client) => client.close()));
  opened = [];
});

async function connect(deps: TaskMcpDeps): Promise<RpcClient> {
  const client = await connectInProcess(createTaskMcpServer({ reportError: () => undefined, ...deps }));
  opened.push(client);
  return client;
}

/** The structured payload of a tool result, checked to agree with the text content. */
function payload(response: RpcResponse): Record<string, any> {
  const result = response.result!;
  expect(result.content).toHaveLength(1);
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  return result.structuredContent;
}

const tasks = () => [
  makeTask({
    id: "t-20260103000000-cccc",
    originalRequest: "Third task",
    createdAt: "2026-01-03T00:00:00.000Z",
    workflowState: "READY",
    finalStatus: "ready"
  }),
  planTask({ id: "t-20260102000000-bbbb", originalRequest: "Second task", createdAt: "2026-01-02T00:00:00.000Z" }),
  makeTask({ id: "t-20260101000000-aaaa", originalRequest: "First task", createdAt: "2026-01-01T00:00:00.000Z" }),
  makeTask({ id: "t-20260104000000-dddd", originalRequest: "Other repo task", repository: { root: OTHER_REPO_ROOT } })
];

describe("protocol surface", () => {
  it("exposes inspection plus submission with accurate annotations", async () => {
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: async () => fakeApi([]).api });
    const listed = (await client.request("tools/list")).result!.tools as Array<Record<string, any>>;
    expect(listed.map((tool) => tool.name).sort()).toEqual(["decide_task", "get_task", "list_tasks", "submit_task"]);
    expect(TOOLS.map((tool) => tool.name).sort()).toEqual(["decide_task", "get_task", "list_tasks", "submit_task"]);
    for (const tool of listed.filter((tool) => tool.name !== "submit_task" && tool.name !== "decide_task")) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
    for (const name of ["submit_task", "decide_task"]) {
      expect(listed.find((tool) => tool.name === name)!.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: true
      });
    }
    const getTask = listed.find((tool) => tool.name === "get_task")!;
    expect(getTask.inputSchema).toMatchObject({ type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] });
    const listTasks = listed.find((tool) => tool.name === "list_tasks")!;
    expect(listTasks.inputSchema.required ?? []).toEqual([]);
  });

  it("answers an unknown tool with a protocol error, not a task read", async () => {
    const fake = fakeApi(tasks());
    const open = vi.fn(async () => fake.api);
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: open });
    for (const name of ["advance_task", "run", "create_task"]) {
      const response = await client.callTool(name, { taskId: "t-1" });
      expect(response.error ?? response.result?.isError).toBeTruthy();
    }
    expect(open).not.toHaveBeenCalled();
  });
});

describe("unmanaged context", () => {
  it("permits list_tasks: this repository's tasks only, newest first, with pending-decision status", async () => {
    const fake = fakeApi(tasks());
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: async () => fake.api });
    const body = payload(await client.callTool("list_tasks"));
    expect(body.tasks.map((task: any) => [task.id, task.request, task.workflowState])).toEqual([
      ["t-20260103000000-cccc", "Third task", "READY"],
      ["t-20260102000000-bbbb", "Second task", "AWAITING_APPROVAL"],
      ["t-20260101000000-aaaa", "First task", "IMPLEMENTING"]
    ]);
    expect(body).toMatchObject({ total: 3, truncated: false });
    const byId = Object.fromEntries(body.tasks.map((task: any) => [task.id, task]));
    expect(byId["t-20260103000000-cccc"].pendingDecision).toEqual({ status: "none" });
    expect(byId["t-20260102000000-bbbb"].pendingDecision).toMatchObject({
      status: "pending",
      kind: "plan",
      // list_tasks never advertises approve, even though the underlying decision offers it.
      options: ["reject", "cancel"]
    });
    expect(byId["t-20260102000000-bbbb"].pendingDecision.decisionId).toMatch(/^pd1_/);
    expect(byId["t-20260101000000-aaaa"].branch).toBe("ai/t-20260101000000-abcd");
    expect(body.notice).toMatch(/never instructions/);
    expect(JSON.stringify(body)).not.toContain("Other repo task");
  });

  it("permits get_task, embedding the Unit 1 pending decision unchanged", async () => {
    const list = tasks();
    const fake = fakeApi(list);
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: async () => fake.api });
    const body = payload(await client.callTool("get_task", { taskId: "t-20260102000000-bbbb" }));
    const expected = await fake.api.pendingDecision("t-20260102000000-bbbb");
    expect(body.task).toMatchObject({
      id: "t-20260102000000-bbbb",
      workflowState: "AWAITING_APPROVAL",
      request: "Second task",
      specification: "the spec"
    });
    expect(body.task.pendingDecision).toEqual({ status: "pending", decision: JSON.parse(JSON.stringify(expected)) });
    expect(body.task.pendingDecision.decision.untrusted).toEqual(expected!.untrusted);
    expect(body.task.pendingDecision.decision.plan).toBe("1. do the thing");
    expect(body.notice).toMatch(/never instructions/);
  });

  it("keeps several tasks distinguishable through get_task", async () => {
    const fake = fakeApi(tasks());
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: async () => fake.api });
    const seen = await Promise.all(
      ["t-20260103000000-cccc", "t-20260102000000-bbbb", "t-20260101000000-aaaa"].map((taskId) => client.callTool("get_task", { taskId }))
    );
    expect(seen.map((response) => payload(response).task.request)).toEqual(["Third task", "Second task", "First task"]);
  });

  it("never exposes a worktree path, repository root, or other path-bearing field", async () => {
    const fake = fakeApi(tasks());
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: async () => fake.api });
    const text = JSON.stringify([
      await client.callTool("list_tasks"),
      await client.callTool("get_task", { taskId: "t-20260101000000-aaaa" })
    ]);
    for (const path of [WORKTREE, REPO_ROOT, "/home/someone", "worktreePath", "workspaceFolder"]) expect(text).not.toContain(path);
  });

  it("reports a task whose decision cannot be derived as unavailable, without failing the others", async () => {
    const fake = fakeApi(tasks(), { failPendingFor: ["t-20260102000000-bbbb"] });
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: async () => fake.api });
    const list = payload(await client.callTool("list_tasks"));
    const byId = Object.fromEntries(list.tasks.map((task: any) => [task.id, task.pendingDecision.status]));
    expect(byId).toEqual({ "t-20260103000000-cccc": "none", "t-20260102000000-bbbb": "unavailable", "t-20260101000000-aaaa": "none" });
    expect(payload(await client.callTool("get_task", { taskId: "t-20260102000000-bbbb" })).task.pendingDecision).toEqual({
      status: "unavailable"
    });
    expect(JSON.stringify(list)).not.toContain("cannot derive");
  });

  it("never asks the store about a stored id that is not a safe task id", async () => {
    // The store builds a file path from any id it is given; an id read out of a record must not reach it.
    const hostile = makeTask({ id: "../../outside", originalRequest: "Hostile id" });
    const fake = fakeApi([hostile, ...tasks()]);
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: async () => fake.api });
    const body = payload(await client.callTool("list_tasks"));
    const entry = body.tasks.find((task: any) => task.request === "Hostile id");
    expect(entry.pendingDecision).toEqual({ status: "unavailable" });
    expect(fake.calls.pendingDecision).not.toContain("../../outside");
    expect(fake.calls.pendingDecision).toContain("t-20260101000000-aaaa");
  });

  it("only ever touches the read-only accessors", async () => {
    const fake = fakeApi(tasks());
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: async () => fake.api });
    await client.callTool("list_tasks");
    await client.callTool("get_task", { taskId: "t-20260101000000-aaaa" });
    await client.callTool("get_task", { taskId: "t-no-such" });
    expect([...fake.accessed].sort()).toEqual(["activity", "currentActivity", "getTask", "listTasks", "pendingDecision", "repoRoot"]);
  });
});

describe("nested-delegation guard", () => {
  const call = (name: string) =>
    name === "get_task"
      ? { taskId: "t-20260101000000-aaaa" }
      : name === "submit_task"
        ? { request: "do work" }
        : name === "decide_task"
          ? { taskId: "t-20260101000000-aaaa", decisionId: "pd1_" + "a".repeat(32), decision: "approve" }
          : {};

  describe.each(["marker", "path", "topology", "indeterminate"] as const)("%s context", (kind) => {
    it.each(TOOLS.map((tool) => tool.name))("refuses %s before any task state is opened or read", async (name) => {
      const fake = fakeApi(tasks());
      const open = vi.fn(async () => fake.api);
      const client = await connect({ detectContext: contexts[kind], openTasks: open });
      const response = await client.callTool(name, call(name));
      expect(response.result!.isError).toBe(true);
      const body = payload(response);
      expect(body.error).toEqual({
        code: "NESTED_DELEGATION_REFUSED",
        message: TOOL_ERRORS.NESTED_DELEGATION_REFUSED,
        context: kind === "indeterminate" ? "indeterminate" : "managed"
      });
      expect(open).not.toHaveBeenCalled();
      expect(fake.calls).toEqual({ listTasks: 0, getTask: [], pendingDecision: [] });
      expect(fake.accessed.size).toBe(0);
    });
  });

  it("leaks no environment value, path, signal name, or detector detail in a refusal", async () => {
    for (const kind of ["marker", "path", "topology", "indeterminate"] as const) {
      const client = await connect({ detectContext: contexts[kind], openTasks: async () => fakeApi([]).api });
      const text = JSON.stringify([await client.callTool("list_tasks"), await client.callTool("get_task", { taskId: "t-1" })]);
      for (const leak of [
        MARKER_VALUE,
        scratch,
        dataDir,
        "AI_ENGINE",
        "worktree_path",
        "task_worktree_topology",
        "ENOENT",
        "EACCES",
        "cwd_unresolvable",
        "git_inspection"
      ]) {
        expect(text).not.toContain(leak);
      }
    }
  });

  it("runs the guard on every call, for every exposed tool, using the shared detector", async () => {
    const detect = vi.fn(contexts.unmanaged);
    const client = await connect({
      detectContext: detect,
      openTasks: async () => fakeApi(tasks()).api,
      submit: async () => ({ taskId: "t-1", phase: "CREATING", worker: "starting" })
    });
    for (const tool of TOOLS) await client.callTool(tool.name, call(tool.name));
    expect(detect).toHaveBeenCalledTimes(TOOLS.length);
    await client.callTool("list_tasks");
    expect(detect).toHaveBeenCalledTimes(TOOLS.length + 1);
  });

  it("guards every tool the server actually lists, not just the ones this test knows", async () => {
    const client = await connect({ detectContext: contexts.marker, openTasks: async () => fakeApi(tasks()).api });
    const listed = (await client.request("tools/list")).result!.tools as Array<{ name: string }>;
    expect(listed.length).toBe(TOOLS.length);
    for (const { name } of listed) {
      const response = await client.callTool(name, call(name));
      expect(payload(response).error.code).toBe("NESTED_DELEGATION_REFUSED");
    }
  });

  it("refuses a managed caller before validating its input", async () => {
    const client = await connect({ detectContext: contexts.marker, openTasks: async () => fakeApi([]).api });
    expect(payload(await client.callTool("get_task", { taskId: "../../etc/passwd" })).error.code).toBe("NESTED_DELEGATION_REFUSED");
  });

  it("fails closed when the detector throws or answers something unrecognised", async () => {
    const open = vi.fn(async () => fakeApi(tasks()).api);
    const throwing = await connect({ detectContext: () => Promise.reject(new Error(`boom ${scratch}`)), openTasks: open });
    const nonsense = await connect({ detectContext: async () => ({ status: "fine" }) as unknown as ManagedContext, openTasks: open });
    for (const client of [throwing, nonsense]) {
      const response = await client.callTool("list_tasks");
      expect(payload(response).error).toMatchObject({ code: "NESTED_DELEGATION_REFUSED", context: "indeterminate" });
      expect(JSON.stringify(response)).not.toContain(scratch);
    }
    expect(open).not.toHaveBeenCalled();
  });

  it("does not let an unmanaged answer be reused: each call re-detects", async () => {
    let status: ManagedContext = { status: "unmanaged" };
    const client = await connect({ detectContext: async () => status, openTasks: async () => fakeApi(tasks()).api });
    expect((await client.callTool("list_tasks")).result!.isError).toBeUndefined();
    status = { status: "managed", signals: ["marker"] };
    expect((await client.callTool("list_tasks")).result!.isError).toBe(true);
  });
});

describe("input validation", () => {
  const malformed = [
    "",
    " ",
    "t-",
    "T-1",
    "../../etc/passwd",
    "t-1/../../x",
    "t-1.json",
    "t-1\n",
    "t-1 ",
    "t--1",
    "t-1-",
    "task-1",
    "t-" + "a".repeat(80),
    "t-\u0000x",
    "t-é"
  ];

  it.each(malformed)("rejects %j as INVALID_TASK_ID without reading any state", async (taskId) => {
    const fake = fakeApi(tasks());
    const open = vi.fn(async () => fake.api);
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: open });
    const response = await client.callTool("get_task", { taskId });
    expect(response.result!.isError).toBe(true);
    expect(payload(response).error).toEqual({ code: "INVALID_TASK_ID", message: TOOL_ERRORS.INVALID_TASK_ID });
    expect(open).not.toHaveBeenCalled();
    expect(fake.calls.getTask).toEqual([]);
  });

  it.each([{}, { taskId: 5 }, { taskId: null }, { taskId: ["t-1"] }, { taskId: { $ne: "" } }])(
    "rejects arguments %j without reading any state or leaking detail",
    async (args) => {
      const fake = fakeApi(tasks());
      const open = vi.fn(async () => fake.api);
      const client = await connect({ detectContext: contexts.unmanaged, openTasks: open });
      const response = await client.callTool("get_task", args as Record<string, unknown>);
      expect(response.result?.isError ?? Boolean(response.error)).toBeTruthy();
      const text = JSON.stringify(response);
      for (const leak of [scratch, "/home", "ENOENT", "node_modules", ".json"]) expect(text).not.toContain(leak);
      expect(open).not.toHaveBeenCalled();
    }
  );

  it("accepts a generated id and any id made of letters and digits joined by hyphens", async () => {
    const list = [makeTask({ id: "t-20260101000000-abcd" }), makeTask({ id: "t-test-0001" })];
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: async () => fakeApi(list).api });
    for (const task of list) expect(payload(await client.callTool("get_task", { taskId: task.id })).task.id).toBe(task.id);
  });
});

describe("errors", () => {
  it("reports an unknown task as TASK_NOT_FOUND", async () => {
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: async () => fakeApi(tasks()).api });
    const response = await client.callTool("get_task", { taskId: "t-20990101000000-ffff" });
    expect(response.result!.isError).toBe(true);
    expect(payload(response).error).toEqual({ code: "TASK_NOT_FOUND", message: TOOL_ERRORS.TASK_NOT_FOUND });
  });

  it("answers a task of another repository exactly as an unknown one", async () => {
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: async () => fakeApi(tasks()).api });
    const other = payload(await client.callTool("get_task", { taskId: "t-20260104000000-dddd" }));
    const unknown = payload(await client.callTool("get_task", { taskId: "t-20990101000000-ffff" }));
    expect(other).toEqual(unknown);
    expect(JSON.stringify(other)).not.toContain("Other repo task");
  });

  it("does not return a record whose stored id differs from the id asked for", async () => {
    const mismatched = makeTask({ id: "t-20260101000000-zzzz" });
    const api = { ...fakeApi([]).api, getTask: async () => mismatched };
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: async () => api });
    expect(payload(await client.callTool("get_task", { taskId: "t-20260101000000-aaaa" })).error.code).toBe("TASK_NOT_FOUND");
  });

  it("reports an unopenable repository without any of the underlying error", async () => {
    const reported: string[] = [];
    const client = await connect({
      detectContext: contexts.unmanaged,
      openTasks: () =>
        Promise.reject(Object.assign(new Error(`Not a git repository: ${scratch}/secret`), { name: "NotAGitRepositoryError" })),
      reportError: (kind) => reported.push(kind)
    });
    for (const [name, args] of [
      ["list_tasks", {}],
      ["get_task", { taskId: "t-20260101000000-aaaa" }]
    ] as const) {
      const response = await client.callTool(name, args);
      expect(payload(response).error).toEqual({ code: "REPOSITORY_UNAVAILABLE", message: TOOL_ERRORS.REPOSITORY_UNAVAILABLE });
      expect(JSON.stringify(response)).not.toContain("secret");
    }
    expect(reported).toEqual(["NotAGitRepositoryError", "NotAGitRepositoryError"]);
  });

  it("reports unreadable task state without the store's message or path", async () => {
    const reported: string[] = [];
    const failing = Object.assign(new Error(`Task "t-1"'s persisted record at ${scratch}/tasks/t-1.json is not valid JSON`), {
      name: "TaskRecordCorruptedError"
    });
    const api = { ...fakeApi([]).api, getTask: () => Promise.reject(failing), listTasks: () => Promise.reject(failing) };
    const client = await connect({
      detectContext: contexts.unmanaged,
      openTasks: async () => api,
      reportError: (kind) => reported.push(kind)
    });
    for (const [name, args] of [
      ["list_tasks", {}],
      ["get_task", { taskId: "t-20260101000000-aaaa" }]
    ] as const) {
      const response = await client.callTool(name, args);
      expect(payload(response).error).toEqual({ code: "TASK_STATE_UNAVAILABLE", message: TOOL_ERRORS.TASK_STATE_UNAVAILABLE });
      expect(JSON.stringify(response)).not.toContain(scratch);
    }
    expect(reported).toEqual(["TaskRecordCorruptedError", "TaskRecordCorruptedError"]);
  });

  it("reports only an error class name, never a message, for an unexpected failure", async () => {
    const reported: string[] = [];
    // A record whose `git` field throws when read stands in for any unexpected failure while building the view.
    const hostile = { ...makeTask({ id: "t-20260101000000-aaaa" }) };
    Object.defineProperty(hostile, "git", {
      get(): never {
        throw new RangeError(`leak ${scratch}`);
      }
    });
    const api = { ...fakeApi([]).api, getTask: async () => hostile };
    const client = await connect({
      detectContext: contexts.unmanaged,
      openTasks: async () => api as never,
      reportError: (kind) => reported.push(kind)
    });
    const response = await client.callTool("get_task", { taskId: "t-20260101000000-aaaa" });
    expect(payload(response).error).toEqual({ code: "INTERNAL_ERROR", message: TOOL_ERRORS.INTERNAL_ERROR });
    expect(JSON.stringify(response)).not.toContain(scratch);
    expect(reported).toEqual(["RangeError"]);
  });
});

describe("bounded output", () => {
  it("documents the whole-result limits: 128 KiB for get_task, 64 KiB for list_tasks", () => {
    expect(MAX_GET_TASK_RESPONSE_BYTES).toBe(128 * 1024);
    expect(MAX_LIST_TASKS_RESPONSE_BYTES).toBe(64 * 1024);
    expect(Object.fromEntries(TOOLS.map((tool) => [tool.name, tool.maxResponseBytes]))).toEqual({
      list_tasks: 64 * 1024,
      get_task: 128 * 1024,
      submit_task: 4096,
      decide_task: 4096
    });
  });

  const giant = "😀x".repeat(1_000_000);

  it("bounds list_tasks however many or however large the tasks are", async () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      makeTask({
        id: `t-2026010100${String(i).padStart(4, "0")}-abcd`,
        originalRequest: giant,
        createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`
      })
    );
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: async () => fakeApi(many).api });
    const response = await client.callTool("list_tasks");
    const body = payload(response);
    // Cut by budget, on a whole-summary boundary: fewer than the count cap, at least one, in order.
    expect(body.tasks.length).toBeGreaterThanOrEqual(1);
    expect(body.tasks.length).toBeLessThan(TASK_VIEW_LIMITS.tasksPerList);
    expect(body).toMatchObject({ total: 300, truncated: true });
    expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(MAX_LIST_TASKS_RESPONSE_BYTES);
    for (const task of body.tasks) expect(Array.from(task.request as string)).toHaveLength(TASK_VIEW_LIMITS.listRequestChars);
  });

  it("bounds get_task for an adversarially large record, including the embedded decision", async () => {
    const huge = planTask({
      id: "t-20260101000000-aaaa",
      originalRequest: giant,
      specification: giant,
      plan: giant,
      failures: [{ at: "t", state: "TESTING", message: giant }],
      verification: [
        {
          taskId: "x",
          createdAt: "t",
          results: Array.from({ length: 2_000 }, (_, i) => ({
            checkId: `c${i}`,
            status: "FAIL" as const,
            durationMs: 1,
            reason: giant,
            output: giant
          }))
        }
      ]
    });
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: async () => fakeApi([huge]).api });
    const response = await client.callTool("get_task", { taskId: "t-20260101000000-aaaa" });
    const body = payload(response);
    expect(body.task.truncated).toBe(true);
    expect(body.task.pendingDecision.decision.truncated).toBe(true);
    expect(body.task.pendingDecision.decision.options).not.toContain("approve");
    expect(Buffer.byteLength(JSON.stringify(response), "utf8")).toBeLessThanOrEqual(MAX_GET_TASK_RESPONSE_BYTES);
  });

  it("withholds approval in what it sends when the plan was cut for the transport, and says why", async () => {
    const plan = "p".repeat(30_000); // within Unit 1's limit, over the presentation limit
    const task = planTask({ id: "t-20260101000000-aaaa", plan });
    const fake = fakeApi([task]);
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: async () => fake.api });
    const original = await fake.api.pendingDecision("t-20260101000000-aaaa");
    expect(original!.options).toContain("approve");
    const decision = payload(await client.callTool("get_task", { taskId: "t-20260101000000-aaaa" })).task.pendingDecision.decision;
    expect(decision.id).toBe(original!.id);
    expect(decision.options).toEqual(["reject", "cancel"]);
    expect(decision.approvalWithheld).toBe("presentation_truncated");
    expect(decision.presentationTruncated).toBe(true);
    expect(decision.untrusted).toEqual(original!.untrusted);
  });

  it("keeps every size bound for the worst record with control characters, quotes and backslashes", async () => {
    const nasty = String.fromCharCode(1).repeat(400_000) + '\\"'.repeat(400_000);
    const huge = planTask({
      id: "t-20260101000000-aaaa",
      originalRequest: nasty,
      specification: nasty,
      plan: nasty,
      failures: [{ at: nasty, state: "TESTING", message: nasty }]
    });
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: async () => fakeApi([huge, ...tasks()]).api });
    const detail = await client.callTool("get_task", { taskId: "t-20260101000000-aaaa" });
    expect(Buffer.byteLength(JSON.stringify(detail), "utf8")).toBeLessThanOrEqual(MAX_GET_TASK_RESPONSE_BYTES);
    expect(detail.result!.isError).toBeUndefined();
    const list = await client.callTool("list_tasks");
    expect(Buffer.byteLength(JSON.stringify(list), "utf8")).toBeLessThanOrEqual(MAX_LIST_TASKS_RESPONSE_BYTES);
    expect(list.result!.isError).toBeUndefined();
  });

  it("measures the limit in bytes, not characters", async () => {
    const payload = { text: "😀".repeat(40) };
    const serialized = JSON.stringify(successResult(payload));
    const chars = serialized.length;
    const bytes = Buffer.byteLength(serialized, "utf8");
    expect(bytes).toBeGreaterThan(chars);
    const deps = resolveDeps({ detectContext: contexts.unmanaged, openTasks: async () => fakeApi([]).api });
    const tool = { ...listTasksTool, run: async () => payload };
    // Exactly at the byte size it is sent; one byte under it is refused. In characters both would pass.
    expect((await runGuarded(deps, { ...tool, maxResponseBytes: bytes }, {})).isError).toBeUndefined();
    expect((await runGuarded(deps, { ...tool, maxResponseBytes: bytes - 1 }, {})).structuredContent).toMatchObject({
      error: { code: "RESPONSE_TOO_LARGE" }
    });
  });

  it("sends nothing oversized, and cuts nothing mid-structure, if a result ever exceeds its limit", async () => {
    const oversized = { ...listTasksTool, maxResponseBytes: 64, run: async () => ({ tasks: [{ id: "t-1", request: "x".repeat(500) }] }) };
    const result = await runGuarded(
      resolveDeps({ detectContext: contexts.unmanaged, openTasks: async () => fakeApi([]).api }),
      oversized,
      {}
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: { code: "RESPONSE_TOO_LARGE", message: TOOL_ERRORS.RESPONSE_TOO_LARGE } });
    expect(JSON.stringify(result)).not.toContain("xxxxx");
  });

  it("truncates by code point through the whole stack: no split surrogate pair on the wire", async () => {
    const list = [makeTask({ originalRequest: "😀".repeat(TASK_VIEW_LIMITS.listRequestChars + 7) })];
    const client = await connect({ detectContext: contexts.unmanaged, openTasks: async () => fakeApi(list).api });
    const request: string = payload(await client.callTool("list_tasks")).tasks[0].request;
    expect(Buffer.from(request, "utf8").toString("utf8")).toBe(request);
    expect(Array.from(request)).toHaveLength(TASK_VIEW_LIMITS.listRequestChars);
    expect(request.endsWith("…")).toBe(true);
  });
});
