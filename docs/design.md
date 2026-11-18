# Claude Harness design outline

Start with a solo developer using Claude Code locally. The developer approves the scope and acceptance evidence and decides when to ship. The work may span a new app, an existing project, a bug fix, or a feature change.

| Milestone | Demonstrate |
| --- | --- |
| Intake | A task draft records the goal, pinned base, allowed paths, acceptance criteria, and unresolved decisions. |
| Verification | A runner checks scope and executes reviewed tests against an isolated Compose project. It waits for service health, preserves bounded evidence, and removes its own resources. Missing or skipped required checks block acceptance. |
| Hooks | Claude Code hooks guard covered edits and invoke verification at completion. A disposable project demonstrates a denial, a failing gate, and a passing repair. |
| Review and orchestration | A fresh reviewer inspects the verified candidate. Parallel builders own separate worktrees, and the integrated candidate receives a fresh gate. |
| Distribution | A versioned Claude Code plugin installs from the repo and is verified in a fresh session. |

## Status

Version 0.1.0 implements each milestone in the `harness` plugin under [plugins/harness](../plugins/harness).

| Milestone | Where | Evidence |
| --- | --- | --- |
| Intake | `/harness:intake`, `harness-architect`, `harness check-task`, `harness prepare` | Task and acceptance-record tests |
| Verification | `harness verify` ([workflow](workflow.md)) | `tests/docker-e2e.test.mjs`, `scripts/demo.sh` |
| Hooks | `hooks/hooks.json`, `scripts/hook.mjs` ([hooks](hooks.md)) | `scripts/demo.sh`, family guard cases |
| Review and orchestration | `/harness:review`, `/harness:orchestrate`, `harness integrate`, `harness run` | `tests/docker-e2e.test.mjs` |
| Distribution | `.claude-plugin/marketplace.json` ([plugin](plugin.md)) | `claude plugin validate --strict` |

Known gaps against the family contract: holdouts are not implemented (the step reports `NOT_RUN`), the demo's end-to-end test drives HTTP and not a browser, and the reviewer is a fresh context from the same vendor. The gate tests the working tree in place; it does not yet build from a clean export of the candidate, so a git-ignored file that the Docker build copies is outside the candidate digest.

Use the [harness family contract](../CONTRACT.md) for design alignment. Keep verification in executable checks and treat the developer's permission model as the enforcement boundary. Separate verifier access is required for tests a builder must not be able to read or edit.

[Claude Code hooks](https://code.claude.com/docs/en/hooks) · [Claude Code plugins](https://code.claude.com/docs/en/plugins)
