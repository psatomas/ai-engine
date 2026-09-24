import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * The explicit-approval boundary for repository-controlled verification
 * commands (see docs/security.md#repository-controlled-verification-commands).
 *
 * A repository can propose arbitrary shell commands via .ai/project.yaml's
 * verification.additionalChecks — that file is git-tracked, meaning anyone
 * who can land a PR can edit it. AI Engine must never execute a
 * repository-proposed command it has not been explicitly told, by a human,
 * to trust, exactly once, for that exact (command, working-directory) pair.
 * This store is that "told" — a machine-local (never git-tracked) allowlist
 * keyed by a hash of the exact command text AND the check's canonical,
 * repository-relative working directory, so:
 *
 *   - a new command is never silently run (see VerificationStatus.NOT_APPROVED)
 *   - an *edited* command (even a single character) requires re-approval —
 *     approving "npm run build" does not approve "npm run build; curl evil"
 *   - a command whose *working directory* changes also requires re-approval
 *     — cwd is execution-relevant (different package.json, different
 *     relative-path files, a different script entirely) and approving a
 *     command at one location never approves the same text at another
 *   - approval lives outside the repository, so a malicious PR cannot also
 *     grant itself approval
 */
export interface CommandApprovalRecord {
  commandHash: string;
  command: string;
  /** The canonical, repository-relative cwd this approval was granted for — see canonicalCwd(). "" means the repository/worktree root itself. */
  cwd: string;
  approvedAt: string;
  approvedBy: string;
}

/**
 * The repository-relative, path-normalized form of a verification check's `cwd`, computed once here
 * so every caller (the runner, the orchestrator, and anything else that grants or consults an
 * approval) uses exactly the same identity — never a caller's own ad hoc join/compare.
 *
 * Deliberately pure and filesystem-free: no realpath, no existence check, no symlink resolution.
 * That is checkContainment's job (packages/verification/src/runner.ts), exercised once, right
 * before execution, against whatever concretely exists on disk at that moment. This function only
 * answers "does this *configured* cwd name the same repository-relative location as before" — the
 * identity question, not the safety question — so it stays fully decoupled from that separate,
 * carefully-scoped execution-time concern.
 *
 * `repoRoot` here is the task's own worktree/workspace root (the same value already threaded
 * through as `RunVerificationOptions.repoRoot`), not any single fixed repository checkout path.
 * Using each task's own root as the anchor is what makes the identity stable *across* tasks: every
 * task's worktree mirrors the same repository layout, so "packages/foo" relative to one task's
 * worktree root is the same repository-relative location as "packages/foo" relative to another
 * task's — even though the two absolute worktree paths are completely different. Binding identity
 * to an absolute, task-transient path instead would force re-approval of the same logical check on
 * every new task, which is not this store's contract (it is repository-scoped, not task-scoped).
 *
 * "" is the canonical identity for "the repository/worktree root itself", whether `cwd` was omitted
 * entirely (VerificationCheck.cwd defaults to the task's root) or explicitly configured to resolve
 * there — both name the same execution location and must produce the same approval identity.
 */
export function canonicalCwd(repoRoot: string | undefined, cwd: string | undefined): string {
  if (!cwd || !repoRoot) return cwd ?? "";
  const resolved = resolve(repoRoot, cwd);
  const rel = relative(repoRoot, resolved);
  // Genuinely outside repoRoot: a relative ".." climb back to it is itself root-dependent (a
  // different number of ".." segments per task's own worktree root), so it would not be a stable
  // cross-task identity the way an in-repo relative path is. checkContainment already refuses to
  // execute anything outside repoRoot regardless of approval, so stability here has no security
  // consequence either way — using the resolved absolute path keeps the identity at least
  // meaningful and inspectable rather than an opaque, root-relative ".." climb.
  return rel.startsWith("..") || isAbsolute(rel) ? resolved : rel;
}

export function hashCommand(command: string, cwd: string): string {
  // A NUL separator can never appear in either input, so distinct (command, cwd) pairs can never
  // collide by plain concatenation (e.g. command="a"+cwd="bc" vs command="ab"+cwd="c").
  return createHash("sha256").update(`${cwd}\0${command}`, "utf8").digest("hex");
}

export class CommandApprovalStore {
  constructor(private readonly filePath: string) {}

  private async readAll(): Promise<Record<string, CommandApprovalRecord>> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, CommandApprovalRecord>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      // A corrupted approval store must fail CLOSED (nothing approved), never open.
      return {};
    }
  }

  private async writeAll(records: Record<string, CommandApprovalRecord>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, JSON.stringify(records, null, 2), "utf8");
    await rename(tmp, this.filePath);
  }

  /** `repoRoot` is the task's own worktree/workspace root — see canonicalCwd() for why. */
  async isApproved(command: string, cwd: string | undefined, repoRoot: string | undefined): Promise<boolean> {
    const records = await this.readAll();
    return hashCommand(command, canonicalCwd(repoRoot, cwd)) in records;
  }

  async getApproval(command: string, cwd: string | undefined, repoRoot: string | undefined): Promise<CommandApprovalRecord | undefined> {
    const records = await this.readAll();
    return records[hashCommand(command, canonicalCwd(repoRoot, cwd))];
  }

  async approve(
    command: string,
    cwd: string | undefined,
    repoRoot: string | undefined,
    approvedBy: string
  ): Promise<CommandApprovalRecord> {
    const records = await this.readAll();
    const canonical = canonicalCwd(repoRoot, cwd);
    const record: CommandApprovalRecord = {
      commandHash: hashCommand(command, canonical),
      command,
      cwd: canonical,
      approvedAt: new Date().toISOString(),
      approvedBy
    };
    records[record.commandHash] = record;
    await this.writeAll(records);
    return record;
  }

  async revoke(command: string, cwd: string | undefined, repoRoot: string | undefined): Promise<boolean> {
    const records = await this.readAll();
    const hash = hashCommand(command, canonicalCwd(repoRoot, cwd));
    if (!(hash in records)) return false;
    delete records[hash];
    await this.writeAll(records);
    return true;
  }

  async list(): Promise<CommandApprovalRecord[]> {
    return Object.values(await this.readAll());
  }
}
