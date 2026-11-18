---
name: plan
description: Phase 2 pre-build freeze gate. Pushes back if intake blockers remain, locks `SPEC.md`, Compose healthchecks, and Milestone 1.5 Frozen Adversarial Tests, then activates an approved task or multi-node plan (`factory activate` / `factory approve-plan`). Also deactivates a finished or cancelled task.
argument-hint: <task.json | plan.json> [acceptance.json] | off
disable-model-invocation: true
---

Lock contracts, freeze adversarial tests, and execute the owner checkpoint (Phase 2) for: $ARGUMENTS

If the argument is `off`, run `deactivate` and report which task was archived.

> **Pre-Build Freeze Gate (Pushback Rule):** Refuse to run `activate` or `approve-plan` if any blocking intake decision or `unresolved_decisions` entry remains open, if `SPEC.md`/Compose healthchecks are missing, or if **Milestone 1.5 Frozen Adversarial Tests** (or bug reproduction tests) have not been landed in the base commit and observed failing first.

## Step 1: Lock Contracts & Milestone 1.5 Frozen Adversarial Tests

Before activating any builder task or plan:
1. Ensure `SPEC.md`, API/DB schemas, `docker-compose.yml` (`healthcheck` + `condition: service_healthy`), and `factory.json` protected paths are committed on the base commit.
2. Author **Milestone 1.5 Frozen Adversarial Tests** in `tests/` / `acceptance/` covering happy paths and all applicable **4-Part State & Edge-Case Matrix** scenarios (with explicit `data-testid` attributes on UI controls).
3. Confirm the new tests fail as expected for missing implementation, then commit all acceptance inputs so they sit cleanly in the base commit (protected by `PreToolUse` and `.claude/settings.json` deny rules).

## Step 2: Single-Task Activation vs. Multi-Node Plan Approval

### Single Task (`<task.json> [acceptance.json]`)
Validate the task and ensure its acceptance record has cleared `unresolved_decisions`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" check-task <task.json>
```

If no acceptance record was given, draft one with `prepare <task.json> --out <record>`. Show the owner the task ID, base commit, allowed paths, and criterion mappings (do not clear `unresolved_decisions` without explicit owner approval). Then freeze and activate:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" activate <task.json> --acceptance <record.json>
```

### Multi-Node Parallel Plan (`<plan.json>`)
When splitting a parent task into disjoint parallel worktree nodes (`{ "schema_version": 1, "task": <parent>, "acceptance": <record>, "nodes": [{ "task": <node>, "acceptance": <record>, "depends_on": [] }] }`):
- Verify pairwise-disjoint `allowed_paths` across independent nodes (shared contracts belong in one node; overlapping sequential dependencies use `depends_on`).
- Node acceptance records may cite automated checks only (manual observations belong to the parent on the integrated candidate).
- Present the plan to the owner and lock every node's `base_ref` to the resolved SHA:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" approve-plan <plan.json>
```

Activation stores frozen inputs in the Git common directory outside the working tree. Proceed to `/factory:build`.
