import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ContextBlock } from "@ai-engine/core";
import { projectAiDir } from "@ai-engine/config";

const KNOWLEDGE_DIRS = ["context", "architecture", "decisions", "invariants"];
const MAX_FILES = 40;
const MAX_FILE_BYTES = 20_000;

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

/**
 * Loads everything under .ai/{context,architecture,decisions,invariants}/
 * as repository_content context blocks — project knowledge the operator
 * has curated, but still not an instruction channel (see docs/security.md
 * on why even human-authored repo files stay at the repository_content
 * trust level).
 */
export async function loadProjectContext(repoRoot: string): Promise<ContextBlock[]> {
  const aiDir = projectAiDir(repoRoot);
  const files: string[] = [];
  for (const sub of KNOWLEDGE_DIRS) {
    await walk(join(aiDir, sub), files);
  }
  const blocks: ContextBlock[] = [];
  for (const file of files.slice(0, MAX_FILES)) {
    try {
      const content = await readFile(file, "utf8");
      blocks.push({
        trust: "repository_content",
        label: relative(repoRoot, file),
        content: content.length > MAX_FILE_BYTES ? content.slice(0, MAX_FILE_BYTES) + "\n...[truncated]" : content
      });
    } catch {
      // Best-effort: an unreadable file (permissions, race with deletion) is skipped, not fatal.
    }
  }
  return blocks;
}
