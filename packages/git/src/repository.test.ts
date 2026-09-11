import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitRepository, NotAGitRepositoryError } from "./repository.js";

let repoDir: string;
let worktreesDir: string;

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "ai-engine-git-test-"));
  worktreesDir = await mkdtemp(join(tmpdir(), "ai-engine-git-worktrees-"));
  const git = simpleGit(repoDir);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
  await writeFile(join(repoDir, "README.md"), "hello\n");
  await git.add(".");
  await git.commit("initial commit");
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
  await rm(worktreesDir, { recursive: true, force: true });
});

describe("GitRepository", () => {
  it("discovers the repo root and rejects non-repo directories", async () => {
    const repo = await GitRepository.discover(repoDir);
    expect(repo.root).toBe(
      await simpleGit(repoDir)
        .revparse(["--show-toplevel"])
        .then((s) => s.trim())
    );

    const nonRepoDir = await mkdtemp(join(tmpdir(), "ai-engine-not-a-repo-"));
    await expect(GitRepository.discover(nonRepoDir)).rejects.toThrow(NotAGitRepositoryError);
    await rm(nonRepoDir, { recursive: true, force: true });
  });

  it("captures a clean baseline", async () => {
    const repo = await GitRepository.discover(repoDir);
    const baseline = await repo.captureBaseline();
    expect(baseline.branch).toBe("main");
    expect(baseline.dirtyAtStart).toBe(false);
    expect(baseline.untrackedAtStart).toEqual([]);
  });

  it("detects a dirty working tree and untracked files", async () => {
    await writeFile(join(repoDir, "scratch.txt"), "wip");
    await writeFile(join(repoDir, "README.md"), "hello\nmodified\n");
    const repo = await GitRepository.discover(repoDir);
    const baseline = await repo.captureBaseline();
    expect(baseline.dirtyAtStart).toBe(true);
    expect(baseline.untrackedAtStart).toContain("scratch.txt");
  });

  it("creates and removes an isolated task worktree without touching the main tree", async () => {
    const repo = await GitRepository.discover(repoDir);
    const baseline = await repo.captureBaseline();

    const { path, branch } = await repo.createTaskWorktree("task-42", worktreesDir, baseline.commit);
    expect(branch).toBe("ai/task-42");

    await writeFile(join(path, "new-file.txt"), "agent wrote this");
    const worktreeGit = simpleGit(path);
    await worktreeGit.add(".");
    await worktreeGit.commit("agent change");

    // Main working tree must be untouched.
    const mainStatus = await repo.status();
    expect(mainStatus.dirty).toBe(false);

    const diff = await repo.diff(baseline.commit, "HEAD", path);
    expect(diff.files.map((f) => f.path)).toContain("new-file.txt");

    await repo.removeTaskWorktree(path, { force: true });
    await repo.deleteTaskBranch(branch, { force: true });
  });

  it("flags suspicious paths in a diff", async () => {
    const repo = await GitRepository.discover(repoDir);
    const baseline = await repo.captureBaseline();
    const { path } = await repo.createTaskWorktree("task-suspicious", worktreesDir, baseline.commit);

    const wfDir = join(path, ".github", "workflows");
    await simpleGit(path).raw(["config", "user.email", "x@x.com"]);
    await simpleGit(path).raw(["config", "user.name", "x"]);
    const fs = await import("node:fs/promises");
    await fs.mkdir(wfDir, { recursive: true });
    await fs.writeFile(join(wfDir, "ci.yml"), "name: ci\n");
    await simpleGit(path).add(".");
    await simpleGit(path).commit("touch ci workflow");

    const diff = await repo.diff(baseline.commit, "HEAD", path);
    expect(diff.suspiciousFiles).toContain(".github/workflows/ci.yml");

    await repo.removeTaskWorktree(path, { force: true });
  });
});
