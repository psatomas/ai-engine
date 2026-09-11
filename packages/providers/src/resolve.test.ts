import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProviderBinary } from "./resolve.js";

const originalHome = process.env.HOME;
const originalPath = process.env.PATH;

let fakeHome: string;

async function makeExecutable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\necho fake\n");
  await chmod(path, 0o755);
}

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), "ai-engine-fakehome-"));
  process.env.HOME = fakeHome;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.PATH = originalPath;
  await rm(fakeHome, { recursive: true, force: true });
});

describe("resolveProviderBinary", () => {
  it("prefers an explicitly configured path over everything else", async () => {
    const configured = join(fakeHome, "custom-codex");
    await makeExecutable(configured);
    const result = await resolveProviderBinary({
      configuredPath: configured,
      pathExecutableName: "codex",
      vscodeExtensionIdPrefix: "openai.chatgpt-",
      vscodeExecutableBasename: "codex"
    });
    expect(result).toEqual({ path: configured, source: "configured" });
  });

  it("falls back to PATH when nothing is configured", async () => {
    const binDir = join(fakeHome, "bin");
    await mkdir(binDir, { recursive: true });
    const bin = join(binDir, "codex");
    await makeExecutable(bin);
    process.env.PATH = `${binDir}:${originalPath}`;

    const result = await resolveProviderBinary({
      pathExecutableName: "codex",
      vscodeExtensionIdPrefix: "openai.chatgpt-",
      vscodeExecutableBasename: "codex"
    });
    expect(result).toEqual({ path: bin, source: "path" });
  });

  it("falls back to the newest matching VS Code extension install", async () => {
    process.env.PATH = "/nonexistent-bin-dir";
    const extRoot = join(fakeHome, ".vscode", "extensions");
    const older = join(extRoot, "openai.chatgpt-1.0.0", "bin", "linux-x86_64", "codex");
    const newer = join(extRoot, "openai.chatgpt-2.0.0", "bin", "linux-x86_64", "codex");
    await mkdir(join(extRoot, "openai.chatgpt-1.0.0", "bin", "linux-x86_64"), { recursive: true });
    await mkdir(join(extRoot, "openai.chatgpt-2.0.0", "bin", "linux-x86_64"), { recursive: true });
    await makeExecutable(older);
    await makeExecutable(newer);

    const result = await resolveProviderBinary({
      pathExecutableName: "codex",
      vscodeExtensionIdPrefix: "openai.chatgpt-",
      vscodeExecutableBasename: "codex"
    });
    expect(result?.source).toBe("vscode-extension");
    expect(result?.path).toBe(newer);
  });

  /**
   * Regression: the previous implementation sorted extension directory names
   * lexicographically ("...9.0.0..." sorts *after* "...10.0.0..." as plain
   * strings, since '9' > '1'), which would pick the OLDER binary the moment
   * a version segment crossed a digit-count boundary. This forces exactly
   * that boundary.
   */
  it("picks the numerically newest version even across a digit-count boundary (9.x vs 10.x)", async () => {
    process.env.PATH = "/nonexistent-bin-dir";
    const extRoot = join(fakeHome, ".vscode", "extensions");
    const nine = join(extRoot, "openai.chatgpt-9.900.0-linux-x86_64", "bin", "linux-x86_64", "codex");
    const ten = join(extRoot, "openai.chatgpt-10.100.0-linux-x86_64", "bin", "linux-x86_64", "codex");
    await mkdir(join(extRoot, "openai.chatgpt-9.900.0-linux-x86_64", "bin", "linux-x86_64"), { recursive: true });
    await mkdir(join(extRoot, "openai.chatgpt-10.100.0-linux-x86_64", "bin", "linux-x86_64"), { recursive: true });
    await makeExecutable(nine);
    await makeExecutable(ten);

    const result = await resolveProviderBinary({
      pathExecutableName: "codex",
      vscodeExtensionIdPrefix: "openai.chatgpt-",
      vscodeExecutableBasename: "codex"
    });
    expect(result?.path).toBe(ten); // 10.100.0 is newer than 9.900.0, despite sorting "lower" as a string
  });

  it("returns undefined when nothing can be found anywhere", async () => {
    process.env.PATH = "/nonexistent-bin-dir";
    const result = await resolveProviderBinary({
      pathExecutableName: "codex",
      vscodeExtensionIdPrefix: "openai.chatgpt-",
      vscodeExecutableBasename: "codex"
    });
    expect(result).toBeUndefined();
  });
});
