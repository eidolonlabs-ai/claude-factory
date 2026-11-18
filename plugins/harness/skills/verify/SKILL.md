---
name: verify
description: Run the harness gate on the current worktree and report concrete verification evidence. Use to check a candidate, establish a baseline, or confirm a repair before claiming anything works.
allowed-tools: Bash(node:*), Read
---

Run the gate on the exact candidate in this worktree:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/harness.mjs" verify
```

The gate checks scope, frozen configuration, and hygiene, runs configured checks, boots the Docker Compose stack under its own project name, waits for health, runs the test service against the live services, audits the diff, and removes what it created. The first failure stops it.

Report the run id, each check with its status, and the evidence directory. With no active task the result is `BASELINE`: the stack works, and nothing was accepted, because scope and frozen inputs were not checked. `NOT_RUN` is never `PASS`: an unreachable Docker daemon or a missing check is a failure to verify, and you say so. Read the logs it names before explaining a failure, and distinguish a product defect from an unavailable service.

A criterion mapped to a manual observation leaves the gate at `PENDING` after the automated checks pass. Only the owner can complete it: they look at the running application and record what they saw with `harness evidence <criterion-id> --note "..."`, which binds the observation to the current candidate; then `verify` again. Any later change to the candidate makes the observation stale. Never record evidence yourself, never describe evidence you did not observe, and never edit tests, Compose files, or `harness.json` to obtain a pass.
