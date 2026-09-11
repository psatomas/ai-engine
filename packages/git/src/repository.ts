import { simpleGit, type SimpleGit } from "simple-git";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import type { GitBaseline } from "@ai-engine/core";
import { isSuspiciousPath } from "./suspicious.js";

export interface RepoStatus {
  branch: string;
  commit: string;
  dirty: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface ChangedFile {
  path: string;
  status: string;
  suspicious: boolean;
}

export interface DiffSummary {
  files: ChangedFile[];
  raw: string;
  suspiciousFiles: string[];
}

export class NotAGitRepositoryError extends Error {
  constructor(dir: string) {
    super(`"${dir}" is not inside a Git repository`);
    this.name = "NotAGitRepositoryError";
  }
}

/**
 * All Git access for the orchestration engine goes through this class so
 * safety checks (baseline capture, dirty-tree detection, worktree
 * confinement, diff inspection) live in one auditable place. The engine
 * never lets an agent shell out to `git push`/`git reset --hard`/etc.
 * directly against the user's primary checkout — implementation work
 * happens in a dedicated worktree (see createTaskWorktree).
 */
export class GitRepository {
  private constructor(
    public readonly root: string,
    private readonly git: SimpleGit
  ) {}

  static async discover(startDir: string): Promise<GitRepository> {
    const probe = simpleGit(startDir);
    const isRepo = await probe.checkIsRepo();
    if (!isRepo) throw new NotAGitRepositoryError(startDir);
    const root = (await probe.revparse(["--show-toplevel"])).trim();
    return new GitRepository(root, simpleGit(root));
  }

  private clientFor(cwd?: string): SimpleGit {
    return cwd ? simpleGit(cwd) : this.git;
  }

  async status(cwd?: string): Promise<RepoStatus> {
    const client = this.clientFor(cwd);
    const status = await client.status();
    const commit = (await client.revparse(["HEAD"]).catch(() => "")).trim();
    return {
      branch: status.current ?? "HEAD",
      commit,
      dirty: !status.isClean(),
      staged: status.staged,
      unstaged: [...status.modified, ...status.deleted, ...status.renamed.map((r) => r.to)],
      untracked: status.not_added
    };
  }

  /** Snapshot taken before any agent touches the repository. Persisted on the TaskRecord. */
  async captureBaseline(): Promise<GitBaseline> {
    const status = await this.status();
    return {
      branch: status.branch,
      commit: status.commit,
      dirtyAtStart: status.dirty,
      untrackedAtStart: status.untracked
    };
  }

  /**
   * Creates an isolated worktree + dedicated branch for a task, rooted at
   * the captured baseline commit. All agent invocations for the task use
   * this path as their working directory, never the user's primary
   * checkout — so in-progress or unrelated uncommitted changes in the main
   * working tree can never be touched or lost.
   */
  async createTaskWorktree(taskId: string, worktreesRoot: string, baseCommit: string): Promise<{ path: string; branch: string }> {
    await mkdir(worktreesRoot, { recursive: true });
    const branch = `ai/${taskId}`;
    const path = join(worktreesRoot, taskId);
    await this.git.raw(["worktree", "add", "-b", branch, path, baseCommit]);
    return { path, branch };
  }

  async removeTaskWorktree(path: string, opts: { force?: boolean } = {}): Promise<void> {
    try {
      await this.git.raw(["worktree", "remove", ...(opts.force ? ["--force"] : []), path]);
    } catch {
      // Worktree metadata may already be gone; make sure the directory doesn't linger.
      await rm(path, { recursive: true, force: true });
      await this.git.raw(["worktree", "prune"]).catch(() => undefined);
    }
  }

  async deleteTaskBranch(branch: string, opts: { force?: boolean } = {}): Promise<void> {
    await this.git.raw(["branch", opts.force ? "-D" : "-d", branch]).catch(() => undefined);
  }

  /** Structured diff between two refs (or a ref and the working tree when `to` is omitted), run inside `cwd`. */
  async diff(from: string, to: string | undefined, cwd: string): Promise<DiffSummary> {
    const client = this.clientFor(cwd);
    const range = to ? [`${from}..${to}`] : [from];
    const nameStatus = await client.raw(["diff", "--name-status", ...range]);
    const raw = await client.raw(["diff", ...range]);
    const files = nameStatus
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status, ...rest] = line.split("\t");
        const path = rest[rest.length - 1] ?? "";
        return { path, status: status ?? "?", suspicious: isSuspiciousPath(path) };
      });
    return { files, raw, suspiciousFiles: files.filter((f) => f.suspicious).map((f) => f.path) };
  }

  /** Commits every change in `cwd` (a task worktree) if there is anything to commit, giving each agent step a clean diff boundary. */
  async commitAllIfChanged(cwd: string, message: string): Promise<{ committed: boolean; commit?: string }> {
    const client = this.clientFor(cwd);
    const status = await client.status();
    if (status.isClean()) return { committed: false };
    await client.add(["-A"]);
    await client.commit(message);
    return { committed: true, commit: (await client.revparse(["HEAD"])).trim() };
  }

  async currentCommit(cwd?: string): Promise<string> {
    return (await this.clientFor(cwd).revparse(["HEAD"])).trim();
  }

  async isClean(cwd?: string): Promise<boolean> {
    return (await this.clientFor(cwd).status()).isClean();
  }
}
