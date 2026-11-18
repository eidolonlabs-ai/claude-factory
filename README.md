# Claude Harness

A local development harness for [Claude Code](https://code.claude.com/docs), packaged as the `harness` plugin. It turns a request into a scoped task, guards edits while Claude works, and decides "done" by exit codes on a real Docker Compose stack. The owner reviews the evidence and decides when to ship.

| Stage | What runs |
| --- | --- |
| Intake | `/harness:intake` drafts a task with a pinned base, allowed paths, and observable acceptance criteria, and asks about open decisions. |
| Guard | A `PreToolUse` hook denies writes outside the task's paths, to tests and other acceptance inputs, to secrets, and destructive commands. |
| Gate | A `Stop` hook checks scope, boots the Compose stack under its own project name, waits for health, runs the end-to-end test service, and removes what it created. A failing gate blocks completion. |
| Review | `/harness:review` runs a fresh-context reviewer over the task, the gate evidence, and the diff. |
| Parallel work | `/harness:orchestrate` gives each builder its own Git worktree, then gates the integrated candidate. |

## Install

Requires Claude Code, Node.js 20+, Git, and Docker with Compose v2.

```
/plugin marketplace add theRealMarkCastillo/claude-harness
/plugin install harness@claude-harness
```

Start a fresh session, open your project, and run `/harness:setup`. [Installing and adopting](docs/plugin.md) covers local checkouts, updates, and what adoption changes.

## Try it

```bash
bash scripts/demo.sh
```

The demo copies [examples/notes-app](examples/notes-app) to a temporary repository and shows a guard denial, a failing gate on an incomplete fix, and a passing gate after the repair. It needs a running Docker daemon.

## Read next

- [Design outline](docs/design.md) and milestone status
- [Workflow](docs/workflow.md): tasks, activation, verification, review, parallel builders, unattended runs
- [Hooks and trust boundaries](docs/hooks.md)
- [Family contract](CONTRACT.md) shared with the sibling harnesses

## Develop

```bash
npm test
```

```bash
HARNESS_E2E=1 npm test
```

```bash
npm run validate
```

The plugin source is [plugins/harness](plugins/harness); it has no dependencies and no build step. The first command runs the unit tests and every case in the family's `contract/guard-cases.json`. The second adds the tests that boot real Compose stacks.

## Related harnesses

- [Antigravity Harness](https://github.com/theRealMarkCastillo/antigravity-harness)
- [Codex Harness](https://github.com/theRealMarkCastillo/codex-harness)
- [Hermes Harness](https://github.com/theRealMarkCastillo/hermes-harness)

[MIT license](LICENSE)
