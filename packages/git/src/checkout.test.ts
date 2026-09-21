import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckoutInspectionError, inspectCheckout } from "./checkout.js";
import { GitRepository, TASK_BRANCH_PREFIX } from "./repository.js";

let scratch: string;
let repoDir: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "ai-engine-checkout-"));
  repoDir = join(scratch, "repo");
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
  await rm(scratch, { recursive: true, force: true });
});

async function fakeGit(name: string, script: string): Promise<string> {
  const file = join(scratch, name);
  await writeFile(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
  return file;
}

async function failure(promise: Promise<unknown>): Promise<CheckoutInspectionError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CheckoutInspectionError);
    return err as CheckoutInspectionError;
  }
  throw new Error("expected inspectCheckout to reject");
}

describe("inspectCheckout", () => {
  it("reports a directory outside any repository as not a repository", async () => {
    const outside = join(scratch, "plain");
    await mkdir(outside);
    expect(await inspectCheckout(outside)).toEqual({ kind: "not_a_repository" });
  });

  it("reports an ordinary main checkout as a non-linked repository on its branch", async () => {
    expect(await inspectCheckout(repoDir)).toEqual({ kind: "repository", linkedWorktree: false, branch: "main" });
  });

  it("answers the same from a subdirectory of the main checkout", async () => {
    await mkdir(join(repoDir, "a", "b"), { recursive: true });
    expect(await inspectCheckout(join(repoDir, "a", "b"))).toEqual({ kind: "repository", linkedWorktree: false, branch: "main" });
  });

  it("reports a worktree created by createTaskWorktree as linked, on its task branch", async () => {
    const repo = await GitRepository.discover(repoDir);
    const base = (await simpleGit(repoDir).revparse(["HEAD"])).trim();
    const made = await repo.createTaskWorktree("t-20260101000000-abcd", join(scratch, "worktrees"), base);
    expect(made.branch).toBe(`${TASK_BRANCH_PREFIX}t-20260101000000-abcd`);
    expect(await inspectCheckout(made.path)).toEqual({ kind: "repository", linkedWorktree: true, branch: "ai/t-20260101000000-abcd" });
  });

  it("reports an ordinary linked worktree as linked with its own branch", async () => {
    const other = join(scratch, "elsewhere");
    await simpleGit(repoDir).raw(["worktree", "add", "-b", "feature/x", other]);
    expect(await inspectCheckout(other)).toEqual({ kind: "repository", linkedWorktree: true, branch: "feature/x" });
  });

  it("answers the same from a subdirectory of a linked worktree", async () => {
    const other = join(scratch, "elsewhere");
    await simpleGit(repoDir).raw(["worktree", "add", "-b", "feature/x", other]);
    await mkdir(join(other, "deep"), { recursive: true });
    expect(await inspectCheckout(join(other, "deep"))).toEqual({ kind: "repository", linkedWorktree: true, branch: "feature/x" });
  });

  it("reports a detached HEAD as a branchless checkout", async () => {
    const other = join(scratch, "elsewhere");
    await simpleGit(repoDir).raw(["worktree", "add", "--detach", other]);
    expect(await inspectCheckout(other)).toEqual({ kind: "repository", linkedWorktree: true, branch: undefined });
  });

  it("sees through a symlinked spelling of a linked worktree", async () => {
    const other = join(scratch, "elsewhere");
    await simpleGit(repoDir).raw(["worktree", "add", "-b", "feature/x", other]);
    const alias = join(scratch, "alias");
    await symlink(other, alias);
    expect(await inspectCheckout(alias)).toEqual({ kind: "repository", linkedWorktree: true, branch: "feature/x" });
  });

  it("is not fooled by ambient GIT_* variables pointing at a different repository", async () => {
    const outside = join(scratch, "plain");
    await mkdir(outside);
    const env = { ...process.env, GIT_DIR: join(repoDir, ".git"), GIT_WORK_TREE: repoDir };
    expect(await inspectCheckout(outside, { env })).toEqual({ kind: "not_a_repository" });
  });

  it("does not modify the repository", async () => {
    const snapshot = async (): Promise<string[]> => {
      const entries = await readdir(join(repoDir, ".git"), { recursive: true });
      const rows = await Promise.all(
        entries.sort().map(async (entry) => {
          const info = await stat(join(repoDir, ".git", entry));
          return `${entry}:${info.size}:${info.mtimeMs}`;
        })
      );
      return rows;
    };
    const before = await snapshot();
    await inspectCheckout(repoDir);
    expect(await snapshot()).toEqual(before);
    expect((await simpleGit(repoDir).status()).isClean()).toBe(true);
  });

  it("throws rather than answering when git cannot be run", async () => {
    const err = await failure(inspectCheckout(repoDir, { gitBinary: join(scratch, "no-such-git") }));
    expect(err.code).toBe("ENOENT");
  });

  it("throws when the directory itself cannot be entered", async () => {
    const err = await failure(inspectCheckout(join(scratch, "does-not-exist")));
    expect(err.code).toBe("ENOENT");
  });

  it("throws on a git failure that is not the plain 'not a repository' answer", async () => {
    const git = await fakeGit("fatal-git", `echo "fatal: detected dubious ownership in repository at '/secret/path'" >&2\nexit 128`);
    const err = await failure(inspectCheckout(repoDir, { gitBinary: git }));
    expect(err.code).toBe("GIT_EXIT_128");
    expect(err.message).not.toContain("secret");
  });

  it("throws on any other non-zero exit", async () => {
    const git = await fakeGit("exit5-git", "exit 5");
    expect((await failure(inspectCheckout(repoDir, { gitBinary: git }))).code).toBe("GIT_EXIT_5");
  });

  it("throws on output it cannot interpret, without echoing it", async () => {
    const git = await fakeGit("garbage-git", `echo "TOKEN=hunter2"; echo "/very/private/path"; echo third`);
    const err = await failure(inspectCheckout(repoDir, { gitBinary: git }));
    expect(err.code).toBe("GIT_OUTPUT_UNEXPECTED");
    expect(JSON.stringify(err)).not.toContain("hunter2");
    expect(err.message).not.toContain("hunter2");
    expect(err.message).not.toContain("private");
  });

  it("throws when git produces no directories at all", async () => {
    const git = await fakeGit("empty-git", "exit 0");
    expect((await failure(inspectCheckout(repoDir, { gitBinary: git }))).code).toBe("GIT_OUTPUT_UNEXPECTED");
  });

  it("throws on a timeout", async () => {
    const git = await fakeGit("slow-git", "sleep 5");
    expect((await failure(inspectCheckout(repoDir, { gitBinary: git, timeoutMs: 100 }))).code).toBe("TIMEOUT");
  });
});
