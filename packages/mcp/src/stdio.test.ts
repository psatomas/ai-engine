import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TaskStore } from "@ai-engine/orchestrator";
import { connectStdio } from "./test-support/rpc.js";
import { MAX_GET_TASK_RESPONSE_BYTES, MAX_LIST_TASKS_RESPONSE_BYTES } from "./tools.js";
import { makeTask, planTask } from "./test-support/fixtures.js";

// The real stdio boundary: this package's own bin, over real pipes, with the REAL orchestrator, task
// store and detector. Neither model is involved — the only executables on PATH named claude/codex
// are shims that record being run, and the test proves they never were.
const REPO_ROOT_DIR = fileURLToPath(new URL("../../..", import.meta.url));
const VITE_NODE = join(REPO_ROOT_DIR, "node_modules", "vite-node", "vite-node.mjs");
const ENTRY = join(REPO_ROOT_DIR, "packages", "mcp", "src", "bin.ts");
const MARKER_VALUE = "SECRET-MARKER-VALUE-456";
const TASK_ID = "t-20260101000000-abcd";
const TASK_HUGE = "t-20260104000000-gggg";

let scratch: string;
let dataDir: string;
let configDir: string;
let homeDir: string;
let repoDir: string;
let shimDir: string;
let shimLog: string;
let gitDir: string;
let taskWorktree: string;

beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "ai-engine-mcp-stdio-")));
  dataDir = join(scratch, "data");
  configDir = join(scratch, "config");
  homeDir = join(scratch, "home");
  repoDir = join(scratch, "repo");
  shimDir = join(scratch, "bin");
  shimLog = join(scratch, "shim.log");
  for (const dir of [dataDir, configDir, homeDir, repoDir, shimDir]) mkdirSync(dir, { recursive: true });
  gitDir = dirname(execFileSync("which", ["git"], { encoding: "utf8" }).trim());

  for (const name of ["claude", "codex"]) {
    const shim = join(shimDir, name);
    writeFileSync(shim, `#!/bin/sh\necho "${name} $*" >> "${shimLog}"\nexit 0\n`);
    chmodSync(shim, 0o755);
  }

  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--initial-branch=main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(repoDir, "README.md"), "hello\n");
  git("add", ".");
  git("commit", "-m", "init");
  taskWorktree = join(scratch, "elsewhere", TASK_ID);
  git("worktree", "add", "-b", `ai/${TASK_ID}`, taskWorktree);

  const store = new TaskStore(join(dataDir, "tasks"));
  const here = { root: repoDir };
  await store.save(
    makeTask({
      id: "t-20260101000000-aaaa",
      repository: here,
      workspaceFolder: repoDir,
      originalRequest: "First task",
      createdAt: "2026-01-01T00:00:00.000Z",
      git: {
        branch: "main",
        commit: "abc",
        worktreePath: join(dataDir, "worktrees", "t-20260101000000-aaaa"),
        taskBranch: "ai/t-20260101000000-aaaa",
        dirtyAtStart: false,
        untrackedAtStart: []
      }
    })
  );
  await store.save(
    planTask({
      id: "t-20260102000000-bbbb",
      repository: here,
      workspaceFolder: repoDir,
      originalRequest: "Second task",
      createdAt: "2026-01-02T00:00:00.000Z"
    })
  );
  // An adversarial task of THIS repository: multi-megabyte fields full of control characters, quotes and backslashes.
  const nasty = String.fromCharCode(1).repeat(500_000) + '\\"'.repeat(500_000) + "😀".repeat(500_000);
  await store.save(
    planTask({
      id: TASK_HUGE,
      repository: here,
      workspaceFolder: repoDir,
      originalRequest: nasty,
      specification: nasty,
      plan: nasty,
      failures: [{ at: nasty, state: "TESTING", message: nasty }],
      createdAt: "2026-01-04T00:00:00.000Z"
    })
  );
  await store.save(
    makeTask({
      id: "t-20260103000000-cccc",
      repository: { root: join(scratch, "some-other-repo") },
      originalRequest: "Other repo task",
      createdAt: "2026-01-03T00:00:00.000Z"
    })
  );
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const children = new Set<ChildProcessWithoutNullStreams>();
afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
});

function launch(options: { cwd: string; env?: NodeJS.ProcessEnv; path?: string }) {
  const child = spawn(process.execPath, [VITE_NODE, "--root", REPO_ROOT_DIR, ENTRY], {
    cwd: options.cwd,
    env: {
      PATH: options.path ?? [shimDir, gitDir, "/usr/bin", "/bin"].join(":"),
      HOME: homeDir,
      AI_ENGINE_DATA_DIR: dataDir,
      AI_ENGINE_CONFIG_DIR: configDir,
      ...options.env
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  children.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return { child, stderr: () => stderr };
}

/** Every file's relative path, size, mtime and content hash under `root`: any write of any kind changes it. */
function snapshot(root: string): string[] {
  const rows: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      const info = statSync(full);
      const rel = full.slice(root.length);
      if (entry.isDirectory()) {
        rows.push(`d ${rel} ${info.mtimeMs}`);
        walk(full);
      } else {
        rows.push(`f ${rel} ${info.size} ${info.mtimeMs} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
      }
    }
  };
  walk(root);
  return rows;
}

const text = (response: { result?: Record<string, any> }): string => JSON.stringify(response);
const errorCode = (response: { result?: Record<string, any> }): string => response.result!.structuredContent.error.code;

describe("stdio MCP server, real orchestrator, no model", () => {
  it("serves list_tasks and get_task from an unmanaged context, and changes nothing", async () => {
    const before = { data: snapshot(dataDir), config: snapshot(configDir), repo: snapshot(repoDir), worktree: snapshot(taskWorktree) };
    const { child, stderr } = launch({ cwd: repoDir });
    const client = await connectStdio(child);

    const tools = ((await client.request("tools/list")).result!.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
    expect(tools).toEqual(["get_task", "list_tasks"]);

    const list = (await client.callTool("list_tasks")).result!;
    expect(list.isError).toBeUndefined();
    const listed = list.structuredContent.tasks.map((task: any) => [task.id, task.workflowState]);
    expect(listed).toEqual([
      [TASK_HUGE, "AWAITING_APPROVAL"],
      ["t-20260102000000-bbbb", "AWAITING_APPROVAL"],
      ["t-20260101000000-aaaa", "IMPLEMENTING"]
    ]);
    expect(list.structuredContent.tasks[1].request).toBe("Second task");
    expect(list.structuredContent.tasks[1].pendingDecision).toMatchObject({ status: "pending", kind: "plan" });
    expect(list.structuredContent.tasks[2].pendingDecision).toEqual({ status: "none" });

    const detail = (await client.callTool("get_task", { taskId: "t-20260102000000-bbbb" })).result!;
    expect(detail.structuredContent.task).toMatchObject({ id: "t-20260102000000-bbbb", request: "Second task", specification: "the spec" });
    expect(detail.structuredContent.task.pendingDecision.decision.plan).toBe("1. do the thing");

    // The multi-megabyte task: presented within the wire bounds, with approval withheld because its plan was cut.
    const huge = await client.callTool("get_task", { taskId: TASK_HUGE });
    expect(huge.result!.isError).toBeUndefined();
    const hugeDecision = huge.result!.structuredContent.task.pendingDecision.decision;
    expect(hugeDecision.options).not.toContain("approve");
    expect(hugeDecision.approvalWithheld).toBe("content_truncated"); // Unit 1 had already withheld it
    expect(hugeDecision.presentationTruncated).toBe(true);

    const unknown = await client.callTool("get_task", { taskId: "t-20990101000000-ffff" });
    expect(errorCode(unknown)).toBe("TASK_NOT_FOUND");
    expect(errorCode(await client.callTool("get_task", { taskId: "t-20260103000000-cccc" }))).toBe("TASK_NOT_FOUND");
    expect(errorCode(await client.callTool("get_task", { taskId: "../../../etc/passwd" }))).toBe("INVALID_TASK_ID");

    // Every line the server wrote, in bytes, on the real pipe: within the bounds, the giant task included.
    const byId = new Map(client.stdoutLines.map((line) => [JSON.parse(line).id, Buffer.byteLength(line, "utf8")]));
    expect(byId.get(3)!).toBeLessThanOrEqual(MAX_LIST_TASKS_RESPONSE_BYTES); // list_tasks
    expect(byId.get(5)!).toBeLessThanOrEqual(MAX_GET_TASK_RESPONSE_BYTES); // get_task of the giant task
    expect(Math.max(...byId.values())).toBeLessThanOrEqual(MAX_GET_TASK_RESPONSE_BYTES);

    // Nothing path-shaped or environment-shaped in anything it said.
    const everything = client.stdoutLines.join("\n");
    for (const leak of [scratch, homeDir, dataDir, repoDir, "worktreePath", "AI_ENGINE_DATA_DIR"]) expect(everything).not.toContain(leak);

    await client.close();
    expect(await client.exit).toBe(0);
    expect(stderr()).toBe("");

    // Read-only, proven on disk: no file in the store, config, repository or task worktree was created, changed or removed.
    expect({ data: snapshot(dataDir), config: snapshot(configDir), repo: snapshot(repoDir), worktree: snapshot(taskWorktree) }).toEqual(
      before
    );
    expect(existsSync(join(dataDir, "tasks", ".locks"))).toBe(false);
    expect(existsSync(join(dataDir, "worktrees"))).toBe(false);
    expect(existsSync(join(dataDir, "logs"))).toBe(false);
    // ...and no model CLI was ever started.
    expect(existsSync(shimLog)).toBe(false);
  }, 90_000);

  it("refuses both tools when the managed-task marker is set, whatever its value", async () => {
    const { child } = launch({ cwd: repoDir, env: { AI_ENGINE_MANAGED_TASK: MARKER_VALUE } });
    const client = await connectStdio(child);
    for (const [name, args] of [
      ["list_tasks", {}],
      ["get_task", { taskId: "t-20260102000000-bbbb" }]
    ] as const) {
      const response = await client.callTool(name, args);
      expect(response.result!.isError).toBe(true);
      expect(errorCode(response)).toBe("NESTED_DELEGATION_REFUSED");
      expect(text(response)).not.toContain("Second task");
    }
    expect(client.stdoutLines.join("\n")).not.toContain(MARKER_VALUE);
    await client.close();
  }, 60_000);

  it("refuses both tools from inside the configured worktrees root, even where nothing is a git repository", async () => {
    const inside = join(dataDir, "worktrees", "t-x", "deep");
    mkdirSync(inside, { recursive: true });
    try {
      const { child } = launch({ cwd: inside });
      const client = await connectStdio(child);
      for (const [name, args] of [
        ["list_tasks", {}],
        ["get_task", { taskId: "t-20260102000000-bbbb" }]
      ] as const) {
        expect(errorCode(await client.callTool(name, args))).toBe("NESTED_DELEGATION_REFUSED");
      }
      await client.close();
    } finally {
      rmSync(join(dataDir, "worktrees"), { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses both tools from a linked task worktree that a custom data dir puts outside the root, with no marker", async () => {
    const { child } = launch({ cwd: taskWorktree });
    const client = await connectStdio(child);
    for (const [name, args] of [
      ["list_tasks", {}],
      ["get_task", { taskId: "t-20260102000000-bbbb" }]
    ] as const) {
      const response = await client.callTool(name, args);
      expect(errorCode(response)).toBe("NESTED_DELEGATION_REFUSED");
      expect(response.result!.structuredContent.error.context).toBe("managed");
    }
    await client.close();
  }, 60_000);

  it("refuses both tools when the context cannot be established (git unavailable), rather than assuming unmanaged", async () => {
    const { child } = launch({ cwd: repoDir, path: shimDir });
    const client = await connectStdio(child);
    for (const [name, args] of [
      ["list_tasks", {}],
      ["get_task", { taskId: "t-20260102000000-bbbb" }]
    ] as const) {
      const response = await client.callTool(name, args);
      expect(errorCode(response)).toBe("NESTED_DELEGATION_REFUSED");
      expect(response.result!.structuredContent.error.context).toBe("indeterminate");
      expect(text(response)).not.toContain("ENOENT");
    }
    await client.close();
    expect(existsSync(shimLog)).toBe(false);
  }, 60_000);

  it("reports an unusable repository as REPOSITORY_UNAVAILABLE without echoing the path", async () => {
    const plain = join(scratch, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    const { child } = launch({ cwd: plain });
    const client = await connectStdio(child);
    const response = await client.callTool("list_tasks");
    expect(errorCode(response)).toBe("REPOSITORY_UNAVAILABLE");
    expect(client.stdoutLines.join("\n")).not.toContain(plain);
    await client.close();
  }, 60_000);
});
