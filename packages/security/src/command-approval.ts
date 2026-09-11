import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The explicit-approval boundary for repository-controlled verification
 * commands (see docs/security.md#repository-controlled-verification-commands).
 *
 * A repository can propose arbitrary shell commands via .ai/project.yaml's
 * verification.additionalChecks — that file is git-tracked, meaning anyone
 * who can land a PR can edit it. AI Engine must never execute a
 * repository-proposed command it has not been explicitly told, by a human,
 * to trust, exactly once, for that exact command string. This store is that
 * "told" — a machine-local (never git-tracked) allowlist keyed by a hash of
 * the exact command text, so:
 *
 *   - a new command is never silently run (see VerificationStatus.NOT_APPROVED)
 *   - an *edited* command (even a single character) requires re-approval —
 *     approving "npm run build" does not approve "npm run build; curl evil"
 *   - approval lives outside the repository, so a malicious PR cannot also
 *     grant itself approval
 */
export interface CommandApprovalRecord {
  commandHash: string;
  command: string;
  approvedAt: string;
  approvedBy: string;
}

export function hashCommand(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
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

  async isApproved(command: string): Promise<boolean> {
    const records = await this.readAll();
    return hashCommand(command) in records;
  }

  async getApproval(command: string): Promise<CommandApprovalRecord | undefined> {
    const records = await this.readAll();
    return records[hashCommand(command)];
  }

  async approve(command: string, approvedBy: string): Promise<CommandApprovalRecord> {
    const records = await this.readAll();
    const record: CommandApprovalRecord = {
      commandHash: hashCommand(command),
      command,
      approvedAt: new Date().toISOString(),
      approvedBy
    };
    records[record.commandHash] = record;
    await this.writeAll(records);
    return record;
  }

  async revoke(command: string): Promise<boolean> {
    const records = await this.readAll();
    const hash = hashCommand(command);
    if (!(hash in records)) return false;
    delete records[hash];
    await this.writeAll(records);
    return true;
  }

  async list(): Promise<CommandApprovalRecord[]> {
    return Object.values(await this.readAll());
  }
}
