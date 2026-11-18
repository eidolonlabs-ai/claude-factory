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

Report the run id, each check with its status, and the evidence directory. `NOT_RUN` is never `PASS`: an unreachable Docker daemon or a missing check is a failure to verify, and you say so. Read the logs it names before explaining a failure, and distinguish a product defect from an unavailable service.

A criterion mapped to a manual observation stays pending until someone observes it on the running application. Never describe evidence you did not observe, and never edit tests, Compose files, or `harness.json` to obtain a pass.
