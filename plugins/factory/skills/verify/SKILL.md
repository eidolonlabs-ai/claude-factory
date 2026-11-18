---
name: verify
description: Phase 4A deterministic verification gate (`factory verify`) and live UI browser verification (Desktop Browser pane / Playwright). Enforces `NOT_RUN !== PASS`.
allowed-tools: Bash(node:*), Read
---

Run the external factory gate on the exact candidate in this worktree (Phase 4A):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" verify
```

The gate checks scope, frozen configuration, and hygiene, runs configured checks, boots the Docker Compose stack under its own project name, waits for health, runs the end-to-end test service against live services (never mocked databases), runs `diff-audit`, and tears down what it created. The first failure stops it.

## Reporting & Evidence Rules

1. Report the run ID, each check with its status (`PASS`, `FAIL`, or `NOT_RUN`), and the evidence directory (`<git-common-dir>/factory/runs/<run-id>/`).
2. With no active task the result is `BASELINE`: it confirms the stack works, and nothing was accepted because scope and frozen inputs were not checked.
3. **`NOT_RUN` is never `PASS`**: an unreachable Docker daemon, missing Compose service, or missing test check fails acceptance. Read the named log tails before diagnosing failures, and distinguish product defects from unavailable infrastructure.
4. **Live Browser Check**: When the project has a web UI, verify live flows and console/network health in the Claude Desktop Browser pane (`Cmd+Shift+B` / `Ctrl+Shift+B`) or automated Playwright checks inside `compose:e2e`.
5. **Manual Observations (`PENDING`)**: If every automated check passes and a criterion maps to `manual`, only the owner observes the running app and records `factory evidence <criterion-id> --note "..."` for that exact candidate digest, then runs `verify` again. Never fabricate evidence or edit tests, Compose files, or `factory.json` to force a pass.
