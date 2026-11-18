# Claude Harness design outline

Start with a solo developer using Claude Code locally. The developer approves the scope and acceptance evidence and decides when to ship. The work may span a new app, an existing project, a bug fix, or a feature change.

| Milestone | Demonstrate |
| --- | --- |
| Intake | A task draft records the goal, pinned base, allowed paths, acceptance criteria, and unresolved decisions. |
| Verification | A runner checks scope and executes reviewed tests against an isolated Compose project. It waits for service health, preserves bounded evidence, and removes its own resources. Missing or skipped required checks block acceptance. |
| Hooks | Claude Code hooks guard covered edits and invoke verification at completion. A disposable project demonstrates a denial, a failing gate, and a passing repair. |
| Review and orchestration | A fresh reviewer inspects the verified candidate. Parallel builders own separate worktrees, and the integrated candidate receives a fresh gate. |
| Distribution | A versioned Claude Code plugin installs from the repo and is verified in a fresh session. |

Use the [harness family contract](https://github.com/theRealMarkCastillo/hermes-harness/blob/main/CONTRACT.md) for design alignment. Keep verification in executable checks and treat the developer's permission model as the enforcement boundary. Separate verifier access is required for tests a builder must not be able to read or edit.

[Claude Code hooks](https://code.claude.com/docs/en/hooks) · [Claude Code plugins](https://code.claude.com/docs/en/plugins)
