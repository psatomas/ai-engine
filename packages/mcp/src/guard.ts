import { detectManagedContext, type ManagedContext } from "@ai-engine/orchestrator";

/**
 * Whether a tool call may proceed. `context` says only WHY a call was refused ("managed": positive
 * evidence this process runs inside an AI Engine-managed provider session; "indeterminate": the
 * evidence could not be established) — never which signal fired, and never any path, value or error.
 */
export type NestedDelegationVerdict = { allowed: true } | { allowed: false; context: "managed" | "indeterminate" };

/**
 * The single nested-delegation guard every tool goes through. It adds no detection of its own: it
 * asks the shared detector (`detectManagedContext`, which never throws) and fails closed on its
 * answer. Only `unmanaged` proceeds; `managed` and `indeterminate` are refused. A detector that
 * throws anyway, or answers with anything unrecognised, is refused as indeterminate.
 */
export async function guardNestedDelegation(
  detect: () => Promise<ManagedContext> = () => detectManagedContext()
): Promise<NestedDelegationVerdict> {
  let context: ManagedContext;
  try {
    context = await detect();
  } catch {
    return { allowed: false, context: "indeterminate" };
  }
  switch (context?.status) {
    case "unmanaged":
      return { allowed: true };
    case "managed":
      return { allowed: false, context: "managed" };
    default:
      return { allowed: false, context: "indeterminate" };
  }
}
