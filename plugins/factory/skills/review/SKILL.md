---
name: review
description: Phase 4B independent cold-context review of the verified candidate by `factory-reviewer`, enforcing the Reproduce Before Fixing protocol. Use after `/factory:verify` passes and before shipping.
context: fork
agent: factory-reviewer
allowed-tools: Bash(node:*), Bash(git:*), Read, Grep, Glob
---

Review this candidate (Phase 4B). The packet below is everything the builder was asked to do and everything the gate observed.

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" review-packet 2>&1`

If the packet says no task is active or the gate evidence is missing or stale, stop and report that the candidate is unverified.

Read the changed files in full (`git diff main...HEAD` or base-to-HEAD), not only patch hunks. Review correctness against every acceptance criterion and the **4-Part State & Edge-Case Matrix**:
1. Input validation, error paths, and secret/injection safety (`diff-audit`).
2. Concurrency & row locking (`SELECT FOR UPDATE`), duplicate/out-of-order handling, UTC/`as_of` temporal cursors vs `now()`, dual-write graph cleanup before `MERGE`, UI `AbortController` + monotonic counters, and unique `data-testid` attributes.
3. Whether frozen/added tests would genuinely fail if the behavior broke, and that nothing outside `allowed_paths` changed.

## Reproduce Before Fixing

For every defect found:
- Require a standalone failing regression test reproducing the bug first (confirming failure via `/factory:verify`).
- Apply the minimal fix in a scoped repair step, then re-run `/factory:verify` and re-review before asking the owner to merge.

Return findings ordered by severity with `file:line`, triggering input/state, and wrong behavior. Separate confirmed defects from open questions. Say plainly when you found nothing. Never edit files, approve, or merge: the owner decides.
