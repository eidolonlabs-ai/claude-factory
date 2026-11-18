---
name: orchestrate
description: Split an approved task into parallel builders that each own a separate Git worktree and disjoint paths, then gate the integrated candidate. Use for work with independent parts and clear ownership.
argument-hint: <parent task.json>
disable-model-invocation: true
---

Coordinate parallel builders for: $ARGUMENTS

Separately green builders do not make a green application. Only the integrated candidate's gate counts.

1. Split the parent task into nodes. Each node is a complete task with the parent's `base_ref` and `allowed_paths` inside the parent's. Nodes that own overlapping paths, or that need another node's output, declare `depends_on`. Keep shared contracts in one node.
2. Write the plan as `{ "schema_version": 1, "task": <parent>, "nodes": [{ "task": <node>, "depends_on": [] }] }` and show it to the owner. The owner approves it once:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/harness.mjs" approve-plan <plan.json>
```

3. For each wave of nodes whose dependencies are integrated, launch one `harness-builder` agent per node in a single message so they run concurrently. Each builder gets its own worktree. Give each one only its node task file (the path `approve-plan` printed), and tell it to activate with `--approved`, implement, run `verify`, commit on its branch, and report the branch name. Do not use shared-workspace agents to write code in parallel.
4. Inspect each builder's actual diff and gate result. A builder's report is not evidence. A failed or blocked builder stops the wave: bring its evidence to the owner.
5. Integrate the builder branches in dependency order and gate the combined candidate:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/harness.mjs" integrate <parent-id> --branch <node-id>=<branch> --branch <node-id>=<branch>
```

This creates a retained integration worktree and branch. It never merges into the owner's branch. A conflict stops with the worktree kept for inspection.
6. Run `/harness:review` from the integration worktree, then present the gate result, the review findings, and the unresolved risks. The owner decides what merges.
