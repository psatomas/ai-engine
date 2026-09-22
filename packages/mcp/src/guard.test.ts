import { describe, expect, it } from "vitest";
import type { ManagedContext } from "@ai-engine/orchestrator";
import { guardNestedDelegation } from "./guard.js";

const answer = (context: unknown) => () => Promise.resolve(context as ManagedContext);

describe("guardNestedDelegation", () => {
  it("allows only an unmanaged context", async () => {
    expect(await guardNestedDelegation(answer({ status: "unmanaged" }))).toEqual({ allowed: true });
  });

  it("refuses a managed context, whichever signals established it", async () => {
    for (const signals of [
      ["marker"],
      ["worktree_path"],
      ["task_worktree_topology"],
      ["marker", "worktree_path", "task_worktree_topology"]
    ]) {
      expect(await guardNestedDelegation(answer({ status: "managed", signals }))).toEqual({ allowed: false, context: "managed" });
    }
  });

  it("refuses an indeterminate context, whatever failed", async () => {
    const failures = [{ signal: "worktree_path", reason: "cwd_unresolvable", code: "EACCES" }];
    expect(await guardNestedDelegation(answer({ status: "indeterminate", failures }))).toEqual({
      allowed: false,
      context: "indeterminate"
    });
  });

  it("refuses when the detector throws, rejects, or answers with anything else", async () => {
    const verdicts = await Promise.all([
      guardNestedDelegation(() => Promise.reject(new Error("secret"))),
      guardNestedDelegation(() => {
        throw new Error("secret");
      }),
      guardNestedDelegation(answer(undefined)),
      guardNestedDelegation(answer(null)),
      guardNestedDelegation(answer({})),
      guardNestedDelegation(answer({ status: "UNMANAGED" })),
      guardNestedDelegation(answer({ status: true })),
      guardNestedDelegation(answer("unmanaged"))
    ]);
    for (const verdict of verdicts) expect(verdict).toEqual({ allowed: false, context: "indeterminate" });
  });

  it("carries no detail from the detector into the verdict", async () => {
    const verdict = await guardNestedDelegation(
      answer({ status: "managed", signals: ["marker"], secret: "SECRET", failures: [{ code: "EACCES" }] })
    );
    expect(JSON.stringify(verdict)).toBe('{"allowed":false,"context":"managed"}');
  });
});
