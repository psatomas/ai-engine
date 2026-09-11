# VS Code extension

`extensions/vscode` imports `@ai-engine/orchestrator` directly (in-process, same Node runtime as the
extension host) — it does not shell out to the `ai` CLI. Both surfaces call the identical
`Orchestrator` class, so there is exactly one implementation of every state transition, approval
gate, and side effect to keep correct.

## Install

```sh
cd extensions/vscode
npm run package        # builds dist/extension.js (esbuild, bundles all @ai-engine/* deps; only
                        # "vscode" itself stays external) and produces ai-engine-vscode-0.1.0.vsix
code --install-extension ai-engine-vscode-0.1.0.vsix
```

or, for active development, open this repository in VS Code and press **F5** ("Run Extension") to
launch an Extension Development Host with it loaded live.

## What it provides

- **Activity bar icon** ("AI Engine") with three views:
  - **Task** — the focused task's id, state (including a pending gate, if any), request, branch,
    worktree path, specification/plan excerpts, agents used, and last failure.
  - **Verification** — the latest verification report's checks, with pass/fail icons.
  - **Review Findings** — every review report's verdict and findings, with severity icons.
- **Status bar item** showing the focused task's current state; clicking it runs "AI: Show Workflow
  Status".
- **Commands** (Command Palette, `Ctrl/Cmd+Shift+P` → "AI: ..."): New Task, Analyze Repository, Plan
  Task, Approve Plan, Implement Task, Run Verification, Approve Verification Command, Review Changes,
  Security Review, Fix Findings, Resume Workflow, Retry Failed Task, Acknowledge Git State Divergence,
  Cancel Workflow, Show Workflow Status, Run Workflow, Refresh.
  - "Analyze Repository" and "Plan Task" both call the same `analyze()` step — the architect role
    produces a specification and a plan together in one pass in this implementation (see
    [workflow.md](./workflow.md)); they're kept as two commands because that's how the mission
    brief names them, but there is only one underlying operation today.
  - "Security Review" is dual-purpose: if the focused task is paused on the `security_review` gate,
    it resolves that gate (prompting Approve/Reject); otherwise it runs the review step fresh, same
    as "Review Changes".
  - "Resume Workflow" is similarly gate-aware: if the focused task has a `pendingGate`, it prompts
    for that gate's decision instead of a bare resume (a bare resume on a gated task is refused by
    the orchestrator with a pointer to use the gate decision instead).
  - "Approve Verification Command" lists any repository-configured verification checks
    (`.ai/project.yaml`) awaiting approval, shows the exact command text, and requires an explicit
    confirmation before approving — the same `CommandApprovalStore` the CLI's `ai approve-check` uses
    (see [security.md](./security.md#repository-controlled-verification-commands)).
  - "Retry Failed Task" recovers a `FAILED` task back to the step it failed at.
  - "Acknowledge Git State Divergence" clears a detected worktree/task-state mismatch after
    confirming you've reviewed it — see [security.md](./security.md#gittask-state-divergence-detection).

## "Focused task" and multi-root workspaces

Each workspace folder remembers its own focused task id in `context.workspaceState`, keyed by folder
path, so multiple repositories open in one window each track their own current task independently.

Which folder a command targets, in a multi-root workspace, is resolved by `ExtensionState.resolveFolder()`
(`extensions/vscode/src/folder-selection.ts`): a single open folder is always unambiguous; with more
than one, the active editor's folder wins; failing that, a previously explicit choice (see below) is
reused; failing that, the extension **prompts** with a quick-pick rather than silently guessing. Your
choice from that prompt is remembered until you pick a different folder (or the active editor changes),
so you aren't asked on every command. This replaced an earlier version that silently defaulted to the
first workspace folder whenever no editor had focus — a real risk of running a command against the
wrong repository with no indication; see the folder-targeting tests in `folder-selection.test.ts` and
`state.test.ts`.

## Known limitations

- There is currently no dedicated inline UI for reading a task's full diff (`ai diff` on the CLI, or
  `git diff` / GitLens against the task's `ai/<task-id>` branch, both work today) or for editing global
  config from within VS Code (edit `~/.config/ai-engine/config.yaml` — see
  [the README's configuration section](../README.md#configuration) — directly, or use `ai config
show`/`path`). Both are natural follow-ups once the core surface has real usage.
- Extension tests (`folder-selection.test.ts`, `state.test.ts`) run under plain `vitest` with a
  minimal hand-written mock of the `vscode` module, not a real `@vscode/test-electron` extension host
  (which needs to download an actual VS Code binary — impractical in a sandboxed build environment).
  This gives real, executable coverage of the extension's own decision logic (notably multi-root
  folder targeting) but is not a substitute for manually verifying actual VS Code UI behavior — tree
  views, command palette entries, quick-picks — after a change.
