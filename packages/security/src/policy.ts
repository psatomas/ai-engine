import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { AgentEvent, ApprovalPolicy } from "@ai-engine/core";
import type { SecurityConfig } from "@ai-engine/config";

export interface CommandCheck {
  denied: boolean;
  matchedPattern?: string;
}

export interface PathCheck {
  allowed: boolean;
  reason?: string;
}

export interface EventVerdict {
  action: "allow" | "terminate" | "warn";
  reason?: string;
}

/**
 * Defense-in-depth on top of each provider's own OS-level sandbox. This
 * engine does not (and cannot, from outside the provider process) enforce a
 * hard boundary by itself — the authoritative boundary is the provider's
 * sandbox flag plus the dedicated git worktree the orchestrator confines
 * work to, and (for repository-controlled verification commands
 * specifically) the explicit CommandApprovalStore gate, which *is* the
 * primary mechanism there — see command-approval.ts and
 * docs/security.md#repository-controlled-verification-commands. What this
 * class adds on top, for commands a provider's own agent decides to run:
 *   1. A fast, explicit deny-list checked before we ever start a run
 *      (destructive commands we refuse to let *any* role attempt). This is
 *      whitespace/case-normalized but is still a heuristic, not a sandbox —
 *      treat a match as a strong signal, not a guarantee that nothing worse
 *      slipped through unmatched.
 *   2. A streaming monitor over provider event output that reacts to a
 *      denied command as soon as it is *reported* (which, depending on the
 *      provider's event protocol, may be after the command has already run
 *      — see docs/providers.md — so this stops a run from continuing, it
 *      does not guarantee the triggering command never executed).
 *   3. Path/workspace confinement checks for anything the orchestrator
 *      itself passes to a provider (--add-dir, working directory, file
 *      references), including a symlink-escape check via realpath.
 */
export class SecurityPolicy {
  constructor(private readonly config: SecurityConfig) {}

  checkCommand(command: string): CommandCheck {
    const normalizedCommand = normalize(command);
    for (const pattern of this.config.deniedCommandPatterns) {
      if (normalizedCommand.includes(normalize(pattern))) {
        return { denied: true, matchedPattern: pattern };
      }
    }
    return { denied: false };
  }

  async checkPath(path: string, allowedRoots: string[]): Promise<PathCheck> {
    const resolvedRoots = allowedRoots.map((r) => resolve(r));
    let target: string;
    try {
      target = await realpath(path);
    } catch {
      // Path may not exist yet (e.g. a file about to be created); fall back to lexical resolution.
      target = resolve(path);
    }
    const withinAny = resolvedRoots.some((root) => isWithin(target, root));
    if (!withinAny) {
      return { allowed: false, reason: `"${path}" resolves outside every allowed root (${resolvedRoots.join(", ")})` };
    }
    return { allowed: true };
  }

  /**
   * Inspects a single streamed provider event; the orchestrator calls
   * run.cancel() when this returns "terminate". `approval` differentiates
   * real behavior (not just a value forwarded to the provider, see
   * docs/security.md#approval-policy): "never" terminates the run outright
   * on a denied-command match; "on_request"/"untrusted_only" downgrade to
   * "warn" (logged, task history records it, run continues) since those
   * policies already indicate the operator accepted a more permissive,
   * reviewed posture for this role.
   */
  evaluateEvent(event: AgentEvent, approval: ApprovalPolicy = "never"): EventVerdict {
    const command = extractCommand(event);
    if (!command) return { action: "allow" };
    const check = this.checkCommand(command);
    if (!check.denied) return { action: "allow" };

    const reason = `denied command pattern matched: "${check.matchedPattern}" in "${command}"`;
    return { action: approval === "never" ? "terminate" : "warn", reason };
  }
}

function extractCommand(event: AgentEvent): string | undefined {
  if (event.type === "command") return event.command;
  if (event.type === "tool_use" && /bash|shell|exec|terminal/i.test(event.tool)) {
    const input = event.input as { command?: string | string[] } | undefined;
    if (!input?.command) return undefined;
    return Array.isArray(input.command) ? input.command.join(" ") : input.command;
  }
  return undefined;
}

/** Collapses whitespace runs and lowercases, so trivial spacing/case variation doesn't defeat an otherwise-matching pattern. Still a substring heuristic, not a parser — see class docs. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isWithin(target: string, root: string): boolean {
  const normalizedTarget = target.endsWith(sep) ? target : target + sep;
  const normalizedRoot = root.endsWith(sep) ? root : root + sep;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot) || target === root;
}
