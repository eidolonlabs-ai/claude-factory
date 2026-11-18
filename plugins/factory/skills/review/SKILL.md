---
name: review
description: Independent review of the verified candidate by a fresh reviewer that sees the task, the gate evidence, and the diff, and none of the builder's conversation. Use after the gate passes and before the owner decides to ship.
context: fork
agent: factory-reviewer
allowed-tools: Bash(node:*), Bash(git:*), Read, Grep, Glob
---

Review this candidate. The packet below is everything the builder was asked to do and everything the gate observed.

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" review-packet 2>&1`

If the packet says no task is active or the gate evidence is missing or stale, stop and report that the candidate is unverified.

Read the changed files in full, not only the diff. Review correctness against each acceptance criterion, error paths, concurrency and ordering, input boundaries, and whether the tests would actually fail if the behavior broke. Check that nothing outside the allowed paths changed.

Return findings ordered by severity. For each: the file and line, what input or state triggers it, and what goes wrong. Separate confirmed defects from questions. Say plainly when you found nothing. Do not edit files, do not approve, and do not infer acceptance from a passing gate: the owner decides.
