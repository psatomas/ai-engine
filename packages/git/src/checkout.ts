import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** What Git itself says about a directory: not a repository at all, or a checkout with its topology and branch. */
export type CheckoutTopology =
  | { kind: "not_a_repository" }
  | {
      kind: "repository";
      /** True for a worktree added by `git worktree add` — its git dir differs from the repository's common git dir. */
      linkedWorktree: boolean;
      /** The checked-out branch's short name; undefined when HEAD is detached. */
      branch: string | undefined;
    };

/**
 * Git could not be asked, or gave an answer that cannot be interpreted. Carries only a short,
 * bounded machine-readable code — never Git's output, paths, or messages — so it is safe to surface.
 */
export class CheckoutInspectionError extends Error {
  constructor(public readonly code: string) {
    super("git checkout inspection failed");
    this.name = "CheckoutInspectionError";
  }
}

export interface InspectCheckoutOptions {
  /** Environment to derive Git's from (default: this process's). `GIT_*` variables are always removed. */
  env?: NodeJS.ProcessEnv;
  gitBinary?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

function boundedCode(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? /^[A-Za-z0-9_]{1,32}$/.test(String(value))
      ? String(value)
      : "UNKNOWN"
    : "UNKNOWN";
}

/**
 * Git is run with every `GIT_*` variable removed (GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, ... would
 * otherwise make Git answer about a different repository than the directory being inspected), a
 * fixed locale so its "not a git repository" wording is stable, and no terminal prompting.
 */
function gitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (!name.toUpperCase().startsWith("GIT_")) env[name] = value;
  }
  env.LC_ALL = "C";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs git and returns its exit status. Only a failure to run it at all (or to read its output) throws. */
async function runGit(cwd: string, args: string[], options: InspectCheckoutOptions): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync(options.gitBinary ?? "git", args, {
      cwd,
      env: gitEnvironment(options.env ?? process.env),
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8",
      windowsHide: true
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const failure = err as { code?: unknown; killed?: boolean; stdout?: unknown; stderr?: unknown };
    if (typeof failure.code === "number" && !failure.killed) {
      return {
        exitCode: failure.code,
        stdout: typeof failure.stdout === "string" ? failure.stdout : "",
        stderr: typeof failure.stderr === "string" ? failure.stderr : ""
      };
    }
    throw new CheckoutInspectionError(failure.killed ? "TIMEOUT" : boundedCode(failure.code));
  }
}

/**
 * Asks Git — not the path — what `cwd` is: outside any repository, or a checkout that either is or
 * is not a linked worktree, and on which branch. Read-only (`rev-parse` and `symbolic-ref` never
 * write), and it never trusts a path component's spelling.
 *
 * A directory Git positively says is not a repository is a normal answer. Anything else that stops
 * Git from answering (Git missing, a timeout, an ownership refusal for a repository that does
 * exist, unreadable output) throws `CheckoutInspectionError` rather than guessing.
 */
export async function inspectCheckout(cwd: string, options: InspectCheckoutOptions = {}): Promise<CheckoutTopology> {
  const dirs = await runGit(cwd, ["rev-parse", "--git-dir", "--git-common-dir"], options);
  if (dirs.exitCode !== 0) {
    if (dirs.exitCode === 128 && /not a git repository/i.test(dirs.stderr)) return { kind: "not_a_repository" };
    throw new CheckoutInspectionError(`GIT_EXIT_${boundedCode(dirs.exitCode)}`);
  }
  const [gitDir, commonDir, ...rest] = dirs.stdout.split("\n").filter((line) => line.length > 0);
  if (gitDir === undefined || commonDir === undefined || rest.length > 0) throw new CheckoutInspectionError("GIT_OUTPUT_UNEXPECTED");

  let linkedWorktree: boolean;
  try {
    // Paths may be relative to cwd. Compare real paths, so symlinked spellings of one directory agree.
    linkedWorktree = (await realpath(resolve(cwd, gitDir))) !== (await realpath(resolve(cwd, commonDir)));
  } catch (err) {
    throw new CheckoutInspectionError(boundedCode((err as { code?: unknown }).code));
  }

  const head = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], options);
  if (head.exitCode === 0) {
    const branch = head.stdout.trim();
    if (branch.length === 0) throw new CheckoutInspectionError("GIT_OUTPUT_UNEXPECTED");
    return { kind: "repository", linkedWorktree, branch };
  }
  if (head.exitCode === 1) return { kind: "repository", linkedWorktree, branch: undefined }; // detached HEAD
  throw new CheckoutInspectionError(`GIT_EXIT_${boundedCode(head.exitCode)}`);
}
