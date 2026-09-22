import { executeDelegatedTask } from "@ai-engine/orchestrator";

// Detached entry: ignored stdio; never print raw exceptions or provider output.
executeDelegatedTask(process.argv[2] ?? "", process.argv[3] ?? "").catch(() => {
  process.exitCode = 1;
});
