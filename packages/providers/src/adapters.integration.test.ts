import { describe, expect, it } from "vitest";
import { CodexProvider } from "./codex.js";
import { ClaudeProvider } from "./claude.js";

/**
 * Real integration smoke test: exercises the actual resolved CLI binaries
 * (PATH or bundled VS Code extension) with a pure diagnostic call
 * (`--version`, `login status` / `auth status`) that makes no model calls
 * and needs no credentials to run — only to report `authenticated: true`.
 * On a machine with neither CLI installed, this degrades to a documented
 * skip rather than a failure, per "integration tests... without requiring
 * credentials in CI".
 */
describe("provider adapters (real CLI, no billed calls)", () => {
  it("codex checkAvailability reflects the actual local installation", async () => {
    const provider = new CodexProvider();
    const availability = await provider.checkAvailability();
    if (!availability.available) {
      console.warn("[skip] Codex CLI not found on this machine:", availability.detail);
      return;
    }
    expect(availability.binaryPath).toBeTruthy();
    expect(typeof availability.authenticated).toBe("boolean");
  });

  it("claude checkAvailability reflects the actual local installation", async () => {
    const provider = new ClaudeProvider();
    const availability = await provider.checkAvailability();
    if (!availability.available) {
      console.warn("[skip] Claude Code CLI not found on this machine:", availability.detail);
      return;
    }
    expect(availability.binaryPath).toBeTruthy();
    expect(typeof availability.authenticated).toBe("boolean");
  });

  it("both adapters advertise the capabilities the default workflow roles require", () => {
    const codex = new CodexProvider();
    const claude = new ClaudeProvider();
    for (const cap of ["analyze", "plan", "implement", "review", "streaming", "cancellation"] as const) {
      expect(codex.capabilities()).toContain(cap);
      expect(claude.capabilities()).toContain(cap);
    }
  });
});
