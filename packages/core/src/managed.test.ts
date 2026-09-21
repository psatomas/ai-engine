import { describe, expect, it } from "vitest";
import { MANAGED_TASK_ENV, managedTaskMarker, withManagedTaskMarker } from "./managed.js";

describe("managed task marker", () => {
  it("uses the documented variable name", () => {
    expect(MANAGED_TASK_ENV).toBe("AI_ENGINE_MANAGED_TASK");
  });

  it("is the task id itself, untouched", () => {
    for (const id of ["t-20260101000000-abcd", "weird id with spaces", "../../etc", "💥", " "]) expect(managedTaskMarker(id)).toBe(id);
  });

  it("is never empty, so an absent id cannot silently disable the marker", () => {
    expect(managedTaskMarker("")).not.toBe("");
    expect(managedTaskMarker("").length).toBeGreaterThan(0);
  });

  it("adds only the marker and preserves every other variable exactly", () => {
    const base = Object.freeze({ PATH: "/usr/bin", HOME: "/home/x", EMPTY: "", ANTHROPIC_API_KEY: "k" });
    const env = withManagedTaskMarker(base, "t-1");
    expect(env).toEqual({ ...base, AI_ENGINE_MANAGED_TASK: "t-1" });
    expect(Object.keys(env).filter((k) => !(k in base))).toEqual(["AI_ENGINE_MANAGED_TASK"]);
  });

  it("does not modify the environment it was given", () => {
    const base = Object.freeze({ PATH: "/usr/bin" });
    expect(() => withManagedTaskMarker(base, "t-1")).not.toThrow();
    expect("AI_ENGINE_MANAGED_TASK" in base).toBe(false);
  });

  it("replaces an inherited marker with this task's own, so a nested session names its actual task", () => {
    expect(withManagedTaskMarker({ AI_ENGINE_MANAGED_TASK: "t-outer" }, "t-inner").AI_ENGINE_MANAGED_TASK).toBe("t-inner");
  });

  it("marks with a non-empty value even for an empty task id", () => {
    expect(withManagedTaskMarker({}, "").AI_ENGINE_MANAGED_TASK).toBeTruthy();
  });
});
