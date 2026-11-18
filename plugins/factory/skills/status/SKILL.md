---
name: status
description: Show the active factory task, the current candidate, and whether the last gate result still describes it.
allowed-tools: Bash(node:*)
---

Current factory state:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" status 2>&1`

Summarize this for the owner in a few lines: the active task and its scope, attempts used, and whether the last gate is fresh or stale. A stale or missing gate means the candidate is unverified. If the task is blocked, name the failing check and the decision the owner needs to make.
