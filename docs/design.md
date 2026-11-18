# Claude Factory design outline

Start with a solo developer using Claude Code locally. The developer approves the scope and acceptance evidence and decides when to ship. The work may span all five entry points: a new app, an existing project, a bug fix, a feature change, or a large-scale refactor/migration ([entry paths](entry-paths.md)).

| Milestone | Demonstrate |
| --- | --- |
| Intake & Pushback | `/factory:intake` (`factory-architect` in Plan Mode) pushes back on incomplete specs across the 4-Part Edge-Case Matrix and drafts a task with pinned base, allowed paths, acceptance criteria, and unresolved decisions. |
| Plan & Freeze | `/factory:plan` locks `SPEC.md`, Compose healthchecks, Milestone 1.5 Frozen Adversarial Tests, and freezes the task or multi-node plan before coding starts. |
| Verification | A runner checks scope and executes reviewed tests against an isolated Compose project. It waits for service health, preserves bounded evidence, and removes its own resources. Missing or skipped required checks block acceptance (`NOT_RUN !== PASS`). |
| Hooks | Claude Code hooks guard covered edits and invoke verification at completion. A disposable project demonstrates a denial, a failing gate, and a passing repair. |
| Review and orchestration | `/factory:review` (`factory-reviewer`) runs a fresh-context audit enforcing Reproduce Before Fixing. `/factory:build` gives parallel builders separate worktrees and gates the integrated candidate. |
| Distribution | A versioned Claude Code plugin installs from the repo and is verified in a fresh session. |

## Status

Version 0.1.0 implements each milestone in the `factory` plugin under [plugins/factory](../plugins/factory).

| Milestone | Where | Evidence |
| --- | --- | --- |
| Intake & Plan | `/factory:pipeline`, `/factory:intake`, `/factory:plan`, `factory-architect`, `factory check-task`, `factory prepare` | Task and acceptance-record tests; [ChronoGraph benchmark](../benchmarks/chronograph/README.md) |
| Verification | `factory verify` ([workflow](workflow.md)) | `tests/docker-e2e.test.mjs`, `scripts/demo.sh` |
| Hooks | `hooks/hooks.json`, `scripts/hook.mjs` ([hooks](hooks.md)) | `scripts/demo.sh`, family guard cases |
| Review and orchestration | `/factory:review`, `/factory:build`, `factory integrate`, `factory run` | `tests/docker-e2e.test.mjs`; a live session with two concurrent builder subagents |
| Distribution | `.claude-plugin/marketplace.json` ([plugin](plugin.md)) | `claude plugin validate --strict` |

Known gaps against the family contract: holdouts are not implemented (the step reports `NOT_RUN`), the demo's end-to-end test drives HTTP and not a browser, and the reviewer is a fresh context from the same vendor. Parallel builders all start from the approved base, so a node cannot build on another node's output within one plan. The gate tests the working tree in place; it does not yet build from a clean export of the candidate, so a git-ignored file that the Docker build copies is outside the candidate digest.

Use the [factory family contract](../CONTRACT.md) for design alignment. Keep verification in executable checks and treat the developer's permission model as the enforcement boundary. Separate verifier access is required for tests a builder must not be able to read or edit.

[Claude Code hooks](https://code.claude.com/docs/en/hooks) · [Claude Code plugins](https://code.claude.com/docs/en/plugins)
