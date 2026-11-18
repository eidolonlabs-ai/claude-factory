---
name: status
description: Inspect active Claude Factory task state, candidate digest freshness, gate evidence, and next owner action.
allowed-tools: Bash(node:*)
---

Current factory state:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" status 2>&1`

Summarize this for the owner clearly and concisely:
- **Active Task & Scope**: task ID, pinned base commit, and `allowed_paths`.
- **Gate Freshness & Attempts**: attempts used and whether the latest gate result matches the current candidate digest (stale or missing means **unverified**).
- **Separate Evidence**: report automated check statuses (`PASS` / `FAIL` / `NOT_RUN`), any pending manual/browser observations, and independent review findings separately.
- **Next Owner Action**: if blocked or failing, name the exact failing check and decision required; never frame exhausted attempt budgets as passing completion.
