import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANAGED_TASK_ENV } from "@ai-engine/core";
import { GitRepository } from "@ai-engine/git";
import { detectManagedContext, type ManagedContext } from "./managed-context.js";

const TASK_ID = "t-20260101000000-abcd";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

let scratch: string;
let dataDir: string;
let worktreesRoot: string;
let plainDir: string;
let repoDir: string;

/** A fully controlled environment: only the data dir, and whatever the test adds. */
const envFor = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ AI_ENGINE_DATA_DIR: dataDir, ...extra });

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "ai-engine-managed-"));
  dataDir = join(scratch, "data");
  worktreesRoot = join(dataDir, "worktrees");
  plainDir = join(scratch, "plain");
  repoDir = join(scratch, "repo");
  await mkdir(worktreesRoot, { recursive: true });
  await mkdir(plainDir);
  await mkdir(repoDir);
  const git = simpleGit(repoDir);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
  await writeFile(join(repoDir, "README.md"), "hello\n");
  await git.add(".");
  await git.commit("initial commit");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await chmod(join(scratch, "locked"), 0o755).catch(() => undefined);
  await rm(scratch, { recursive: true, force: true });
});

async function baseCommit(): Promise<string> {
  return (await simpleGit(repoDir).revparse(["HEAD"])).trim();
}

describe("marker signal", () => {
  it.each([
    ["a task id", TASK_ID],
    ["a malformed non-empty value", "!!not a task id ✗ ../../etc"],
    ["a single space", " "],
    ["the string 0", "0"],
    ["the string false", "false"]
  ])("treats %s as managed, without parsing it", async (_label, value) => {
    expect(await detectManagedContext({ cwd: plainDir, env: envFor({ [MANAGED_TASK_ENV]: value }) })).toEqual({
      status: "managed",
      signals: ["marker"]
    });
  });

  it("does not treat an empty marker as managed", async () => {
    expect(await detectManagedContext({ cwd: plainDir, env: envFor({ [MANAGED_TASK_ENV]: "" }) })).toEqual({ status: "unmanaged" });
  });

  it("does not treat an absent marker as managed, and does not infer unmanaged from it alone", async () => {
    expect(await detectManagedContext({ cwd: plainDir, env: envFor() })).toEqual({ status: "unmanaged" });
    const failing = await detectManagedContext({ cwd: join(scratch, "does-not-exist"), env: envFor() });
    expect(failing.status).toBe("indeterminate");
  });

  it("stays managed when the marker is present and every filesystem signal fails", async () => {
    const result = await detectManagedContext({
      cwd: join(scratch, "does-not-exist"),
      env: envFor({ [MANAGED_TASK_ENV]: TASK_ID }),
      deps: {
        resolveWorktreesRoot: () => {
          throw new Error("config exploded");
        },
        inspectCheckout: () => Promise.reject(new Error("git exploded"))
      }
    });
    expect(result).toEqual({ status: "managed", signals: ["marker"] });
  });
});

describe("worktree path signal", () => {
  it("is managed when cwd is exactly the worktrees root", async () => {
    expect(await detectManagedContext({ cwd: worktreesRoot, env: envFor() })).toEqual({ status: "managed", signals: ["worktree_path"] });
  });

  it("is managed when cwd is nested beneath the root, even where nothing looks like a task", async () => {
    const nested = join(worktreesRoot, "anything", "deeper");
    await mkdir(nested, { recursive: true });
    expect(await detectManagedContext({ cwd: nested, env: envFor() })).toEqual({ status: "managed", signals: ["worktree_path"] });
  });

  it("is not managed for a sibling that merely shares the root's string prefix", async () => {
    for (const sibling of ["worktrees-other", "worktrees2", "worktrees.bak"]) {
      const dir = join(dataDir, sibling);
      await mkdir(join(dir, "inner"), { recursive: true });
      expect(await detectManagedContext({ cwd: dir, env: envFor() })).toEqual({ status: "unmanaged" });
      expect(await detectManagedContext({ cwd: join(dir, "inner"), env: envFor() })).toEqual({ status: "unmanaged" });
    }
  });

  it("is not managed for the root's parent", async () => {
    expect(await detectManagedContext({ cwd: dataDir, env: envFor() })).toEqual({ status: "unmanaged" });
  });

  it("is managed for a symlinked cwd that resolves beneath the root", async () => {
    const real = join(worktreesRoot, "task");
    await mkdir(real);
    const alias = join(scratch, "alias");
    await symlink(real, alias);
    expect(await detectManagedContext({ cwd: alias, env: envFor() })).toEqual({ status: "managed", signals: ["worktree_path"] });
  });

  it("is managed when the root itself is a symlink and cwd is spelled through the real location", async () => {
    const realRoot = join(scratch, "real-root");
    await mkdir(join(realRoot, "task"), { recursive: true });
    await rm(worktreesRoot, { recursive: true });
    await symlink(realRoot, worktreesRoot);
    expect(await detectManagedContext({ cwd: join(realRoot, "task"), env: envFor() })).toEqual({
      status: "managed",
      signals: ["worktree_path"]
    });
    expect(await detectManagedContext({ cwd: join(worktreesRoot, "task"), env: envFor() })).toEqual({
      status: "managed",
      signals: ["worktree_path"]
    });
  });

  it("is not managed for a cwd that looks beneath the root only through a symlink that leaves it", async () => {
    await symlink(plainDir, join(worktreesRoot, "escape"));
    expect(await detectManagedContext({ cwd: join(worktreesRoot, "escape"), env: envFor() })).toEqual({ status: "unmanaged" });
  });

  it("says not managed when the worktrees root does not exist", async () => {
    await rm(worktreesRoot, { recursive: true });
    expect(await detectManagedContext({ cwd: plainDir, env: envFor() })).toEqual({ status: "unmanaged" });
  });

  it("follows AI_ENGINE_DATA_DIR: a directory under the default location is not managed unless the configured root says so", async () => {
    const otherData = join(scratch, "other-data");
    await mkdir(join(otherData, "worktrees", "task"), { recursive: true });
    const cwd = join(otherData, "worktrees", "task");
    expect(await detectManagedContext({ cwd, env: envFor() })).toEqual({ status: "unmanaged" });
    expect(await detectManagedContext({ cwd, env: { AI_ENGINE_DATA_DIR: otherData } })).toEqual({
      status: "managed",
      signals: ["worktree_path"]
    });
  });

  it.skipIf(isRoot)("is indeterminate, not unmanaged, when cwd cannot be canonicalized (EACCES)", async () => {
    const locked = join(scratch, "locked");
    await mkdir(join(locked, "inner"), { recursive: true });
    await chmod(locked, 0o000);
    const result = await detectManagedContext({ cwd: join(locked, "inner"), env: envFor() });
    expect(result.status).toBe("indeterminate");
    if (result.status !== "indeterminate") return;
    expect(result.failures).toContainEqual({ signal: "worktree_path", reason: "cwd_unresolvable", code: "EACCES" });
  });

  it("is indeterminate when cwd does not exist", async () => {
    const result = await detectManagedContext({ cwd: join(scratch, "gone"), env: envFor() });
    expect(result).toMatchObject({ status: "indeterminate" });
    expect((result as Extract<ManagedContext, { status: "indeterminate" }>).failures[0]).toEqual({
      signal: "worktree_path",
      reason: "cwd_unresolvable",
      code: "ENOENT"
    });
  });

  it("is indeterminate when the process working directory cannot be read", async () => {
    vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("uv_cwd secret detail"), { code: "ENOENT" });
    });
    const result = await detectManagedContext({ env: envFor() });
    expect(result).toEqual({
      status: "indeterminate",
      failures: [
        { signal: "worktree_path", reason: "cwd_unresolvable", code: "ENOENT" },
        { signal: "task_worktree_topology", reason: "cwd_unresolvable", code: "ENOENT" }
      ]
    });
    expect(await detectManagedContext({ env: envFor({ [MANAGED_TASK_ENV]: TASK_ID }) })).toEqual({
      status: "managed",
      signals: ["marker"]
    });
  });

  it("is indeterminate when the root cannot be canonicalized for a reason other than absence", async () => {
    const result = await detectManagedContext({
      cwd: plainDir,
      env: envFor(),
      deps: {
        realpath: (path) =>
          path === worktreesRoot ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })) : Promise.resolve(path)
      }
    });
    expect(result).toEqual({
      status: "indeterminate",
      failures: [{ signal: "worktree_path", reason: "worktrees_root_unresolvable", code: "EACCES" }]
    });
  });

  it("is indeterminate when resolving the configured root fails unexpectedly", async () => {
    const result = await detectManagedContext({
      cwd: plainDir,
      env: envFor(),
      deps: {
        resolveWorktreesRoot: () => {
          throw new Error("no home directory");
        }
      }
    });
    expect(result).toEqual({
      status: "indeterminate",
      failures: [{ signal: "worktree_path", reason: "worktrees_root_unresolvable", code: "UNKNOWN" }]
    });
  });

  it("treats only ENOENT from the root as absence", async () => {
    const enoent = await detectManagedContext({
      cwd: plainDir,
      env: envFor(),
      deps: {
        realpath: (path) =>
          path === worktreesRoot ? Promise.reject(Object.assign(new Error("x"), { code: "ENOENT" })) : Promise.resolve(path)
      }
    });
    expect(enoent).toEqual({ status: "unmanaged" });
    const enotdir = await detectManagedContext({
      cwd: plainDir,
      env: envFor(),
      deps: {
        realpath: (path) =>
          path === worktreesRoot ? Promise.reject(Object.assign(new Error("x"), { code: "ENOTDIR" })) : Promise.resolve(path)
      }
    });
    expect(enotdir.status).toBe("indeterminate");
  });
});

describe("git topology signal", () => {
  it("is managed for a real linked task worktree with no marker, matching or not matching the data dir", async () => {
    const repo = await GitRepository.discover(repoDir);
    const made = await repo.createTaskWorktree(TASK_ID, worktreesRoot, await baseCommit());

    expect(await detectManagedContext({ cwd: made.path, env: envFor() })).toEqual({
      status: "managed",
      signals: ["worktree_path", "task_worktree_topology"]
    });
  });

  it("is managed by topology alone when a custom data dir makes the path signal miss", async () => {
    const repo = await GitRepository.discover(repoDir);
    const made = await repo.createTaskWorktree(TASK_ID, join(scratch, "custom", "worktrees"), await baseCommit());

    expect(await detectManagedContext({ cwd: made.path, env: envFor() })).toEqual({
      status: "managed",
      signals: ["task_worktree_topology"]
    });
    await mkdir(join(made.path, "src", "deep"), { recursive: true });
    expect(await detectManagedContext({ cwd: join(made.path, "src", "deep"), env: envFor() })).toEqual({
      status: "managed",
      signals: ["task_worktree_topology"]
    });
  });

  it("is managed by topology alone when the configured root does not exist at all", async () => {
    const repo = await GitRepository.discover(repoDir);
    const made = await repo.createTaskWorktree(TASK_ID, join(scratch, "custom", "worktrees"), await baseCommit());
    await rm(worktreesRoot, { recursive: true });
    expect(await detectManagedContext({ cwd: made.path, env: envFor() })).toEqual({
      status: "managed",
      signals: ["task_worktree_topology"]
    });
  });

  it("reports every positive signal together", async () => {
    const repo = await GitRepository.discover(repoDir);
    const made = await repo.createTaskWorktree(TASK_ID, worktreesRoot, await baseCommit());
    expect(await detectManagedContext({ cwd: made.path, env: envFor({ [MANAGED_TASK_ENV]: TASK_ID }) })).toEqual({
      status: "managed",
      signals: ["marker", "worktree_path", "task_worktree_topology"]
    });
  });

  it("is unmanaged for an ordinary main checkout", async () => {
    expect(await detectManagedContext({ cwd: repoDir, env: envFor() })).toEqual({ status: "unmanaged" });
  });

  it("is unmanaged for an ordinary unrelated linked worktree", async () => {
    const other = join(scratch, "elsewhere");
    await simpleGit(repoDir).raw(["worktree", "add", "-b", "feature/login", other]);
    expect(await detectManagedContext({ cwd: other, env: envFor() })).toEqual({ status: "unmanaged" });
  });

  it.each(["ai/notes", "ai/task-42", "t-20260101000000-abcd", "ai/t-", "team/ai/t-20260101000000-abcd"])(
    "is unmanaged for a linked worktree on branch %s, which is not the task-branch convention",
    async (branch) => {
      const other = join(scratch, "elsewhere");
      await simpleGit(repoDir).raw(["worktree", "add", "-b", branch, other]);
      expect(await detectManagedContext({ cwd: other, env: envFor() })).toEqual({ status: "unmanaged" });
    }
  );

  it("is unmanaged for a main checkout that merely sits on a task-shaped branch", async () => {
    await simpleGit(repoDir).raw(["checkout", "-b", `ai/${TASK_ID}`]);
    expect(await detectManagedContext({ cwd: repoDir, env: envFor() })).toEqual({ status: "unmanaged" });
  });

  it("does not classify an ordinary repository because a path component looks like a task id", async () => {
    const lookalike = join(scratch, TASK_ID, "worktrees", "ai", TASK_ID);
    await mkdir(lookalike, { recursive: true });
    await simpleGit(lookalike).init(["--initial-branch=main"]);
    expect(await detectManagedContext({ cwd: lookalike, env: envFor() })).toEqual({ status: "unmanaged" });
  });

  it("is indeterminate when git cannot answer, and never unmanaged", async () => {
    const result = await detectManagedContext({
      cwd: plainDir,
      env: envFor(),
      deps: { inspectCheckout: () => Promise.reject(Object.assign(new Error("git said: /secret/path"), { code: "GIT_EXIT_128" })) }
    });
    expect(result).toEqual({
      status: "indeterminate",
      failures: [{ signal: "task_worktree_topology", reason: "git_inspection_failed", code: "GIT_EXIT_128" }]
    });
  });

  it("finds a positive signal even when another signal is indeterminate", async () => {
    const result = await detectManagedContext({
      cwd: worktreesRoot,
      env: envFor(),
      deps: { inspectCheckout: () => Promise.reject(new Error("no git")) }
    });
    expect(result).toEqual({ status: "managed", signals: ["worktree_path"] });
  });
});

describe("result model and diagnostics", () => {
  it("keeps every indeterminate diagnostic to bounded codes, never raw errors, paths or output", async () => {
    const secret = "token=hunter2 /home/someone/private";
    const result = await detectManagedContext({
      cwd: plainDir,
      env: envFor(),
      deps: {
        resolveWorktreesRoot: () => {
          throw Object.assign(new Error(secret), { code: secret, detail: secret });
        },
        inspectCheckout: () => Promise.reject(Object.assign(new Error(secret), { code: `lowercase ${secret}`, stderr: secret }))
      }
    });
    expect(result.status).toBe("indeterminate");
    if (result.status !== "indeterminate") return;
    expect(result.failures).toHaveLength(2);
    for (const failure of result.failures) {
      expect(Object.keys(failure).sort()).toEqual(["code", "reason", "signal"]);
      expect(failure.code).toMatch(/^[A-Z][A-Z0-9_]{0,31}$/);
    }
    const text = JSON.stringify(result);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("private");
    expect(text).not.toContain(scratch);
  });

  it("carries no paths or environment values in any result", async () => {
    const repo = await GitRepository.discover(repoDir);
    const made = await repo.createTaskWorktree(TASK_ID, worktreesRoot, await baseCommit());
    const results = [
      await detectManagedContext({ cwd: made.path, env: envFor({ [MANAGED_TASK_ENV]: "sekrit-value", OTHER_SECRET: "sekrit-other" }) }),
      await detectManagedContext({ cwd: plainDir, env: envFor() }),
      await detectManagedContext({ cwd: join(scratch, "gone"), env: envFor() })
    ];
    for (const result of results) {
      const text = JSON.stringify(result);
      expect(text).not.toContain("sekrit");
      expect(text).not.toContain(scratch);
    }
  });

  it("never throws: an unexpected failure inside a signal becomes an indeterminate result", async () => {
    const result = await detectManagedContext({
      cwd: plainDir,
      env: envFor(),
      deps: {
        realpath: () => Promise.resolve(undefined as unknown as string),
        inspectCheckout: () => Promise.resolve(undefined as unknown as never)
      }
    });
    expect(result).toEqual({
      status: "indeterminate",
      failures: [
        { signal: "worktree_path", reason: "worktrees_root_unresolvable", code: "UNEXPECTED" },
        { signal: "task_worktree_topology", reason: "git_inspection_failed", code: "UNEXPECTED" }
      ]
    });
  });

  it("does not mutate the environment or the repository", async () => {
    const repo = await GitRepository.discover(repoDir);
    const made = await repo.createTaskWorktree(TASK_ID, worktreesRoot, await baseCommit());
    const env = Object.freeze(envFor({ [MANAGED_TASK_ENV]: TASK_ID, KEEP: "me" }));
    const snapshot = async (): Promise<string[]> => {
      const entries = await readdir(join(repoDir, ".git"), { recursive: true });
      return Promise.all(
        entries.sort().map(async (entry) => {
          const info = await stat(join(repoDir, ".git", entry));
          return `${entry}:${info.size}:${info.mtimeMs}`;
        })
      );
    };
    const before = await snapshot();
    const envBefore = { ...env };
    await detectManagedContext({ cwd: made.path, env });
    await detectManagedContext({ cwd: repoDir, env });
    expect({ ...env }).toEqual(envBefore);
    expect(await snapshot()).toEqual(before);
    expect((await simpleGit(repoDir).status()).isClean()).toBe(true);
    expect((await simpleGit(made.path).status()).isClean()).toBe(true);
  });

  it("does not consult process state: a hostile-looking process environment changes nothing", async () => {
    vi.stubEnv(MANAGED_TASK_ENV, TASK_ID);
    try {
      expect(await detectManagedContext({ cwd: plainDir, env: envFor() })).toEqual({ status: "unmanaged" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
