import { describe, expect, it } from "vitest";
import { generateTaskId } from "@ai-engine/orchestrator";
import { isSafeTaskId } from "./task-id.js";

describe("isSafeTaskId", () => {
  it("accepts every generated task id", () => {
    for (let i = 0; i < 200; i++) expect(isSafeTaskId(generateTaskId(new Date(1_700_000_000_000 + i * 86_400_000)))).toBe(true);
  });

  it.each(["t-1", "t-test-0001", "t-20260101000000-abcd", "t-A-b-C-9"])("accepts %s", (id) => {
    expect(isSafeTaskId(id)).toBe(true);
  });

  it.each([
    "",
    "t-",
    "t",
    "T-1",
    "x-1",
    "t-1-",
    "t--1",
    "-t-1",
    "t-1/2",
    "t-1\\2",
    "t-1.json",
    "t-1.",
    "../t-1",
    "t-1/..",
    "t-1 ",
    " t-1",
    "t-1\n",
    "t-1\0",
    "t-é",
    "t-1%2f",
    "t-" + "a".repeat(63)
  ])("rejects %j", (id) => {
    expect(isSafeTaskId(id)).toBe(false);
  });

  it("rejects anything that is not a string", () => {
    for (const value of [undefined, null, 1, {}, ["t-1"], Symbol("t-1")]) expect(isSafeTaskId(value)).toBe(false);
  });

  it("accepts an id exactly at the length bound and rejects one over it", () => {
    expect(isSafeTaskId("t-" + "a".repeat(62))).toBe(true);
    expect(isSafeTaskId("t-" + "a".repeat(63))).toBe(false);
  });
});
