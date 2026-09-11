# Project initialization & the `.ai/` convention

Run `ai init` (or "AI: New Task" in VS Code, which will offer to init first) inside any git
repository. It creates only what's immediately useful:

```
.ai/
├── project.yaml       # name, description, per-project role overrides, verification tweaks, review focus
├── context/
│   └── README.md      # starter notes on what belongs here
└── .gitignore         # ignores .ai/state/ (local-only cache; nothing there yet in this version)
```

Everything else — `architecture/`, `decisions/`, `invariants/`, `tasks/`, `reviews/` — is **not**
created up front. `packages/orchestrator/src/project-context.ts` already loads context from
`context/`, `architecture/`, `decisions/`, and `invariants/` if they exist, so create whichever of
those you actually want to populate:

- **`context/`** — what the project is, how it's structured, who it's for.
- **`architecture/`** — how the major pieces fit together.
- **`decisions/`** — ADRs; why something is the way it is, so a future task doesn't "fix" it.
- **`invariants/`** — hard rules a task must never violate (e.g. for a protocol repo: "the total
  supply invariant must hold across every code path").
- **`tasks/`** — written automatically, one `<task-id>.md` file per task (see
  `packages/orchestrator/src/task-summary.ts`), as a human-readable, git-trackable mirror of the
  authoritative task record. Set `writeTaskSummaries: false` in `project.yaml` to disable.
- **`reviews/`** — not currently written to separately; review reports live on the task record and
  in its `tasks/<id>.md` summary. A dedicated per-review file is a natural, low-risk future addition
  if a project wants reviews to survive independently of the task that produced them.

All of this content is loaded as `repository_content`-trust context (see
[security.md](./security.md#trust-levels)) for every relevant role — never as instructions, even
though a human wrote it, because anyone who can land a PR can edit it too.

## What does _not_ live in `.ai/`

The AI Engine software itself (this repository) is installed once, globally, and is never copied
into a project. `.ai/project.yaml` holds only project-specific configuration — verification
overrides, review focus areas, per-project role pins. Machine-wide configuration (which provider
fills which role by default, approval gates, budgets, logging) lives in the global config directory
(`~/.config/ai-engine/config.yaml` on Linux) — see the [README's configuration section](../README.md#configuration)
for the full split and why credentials never belong in either file.

## Per-project role overrides

`project.yaml`'s `roles:` map (empty by default) takes precedence over the global config's `roles:`
map for that repository only — e.g. a protocol/blockchain repo might want:

```yaml
roles:
  security_reviewer:
    providerId: codex
    model: gpt-5-high-reasoning
review:
  protocolSecurityReview: true
  focusAreas: [reentrancy, access-control, oracle-manipulation]
```

`review.focusAreas` and `review.protocolSecurityReview` are read by `Orchestrator.review()`
(`packages/orchestrator/src/orchestrator.ts`) and appended to the reviewer/security-reviewer
instructions to sharpen what "deeper security/protocol review" means for a given repository, per the
mission's "For protocol/blockchain repositories, allow deeper security/protocol review" requirement.
