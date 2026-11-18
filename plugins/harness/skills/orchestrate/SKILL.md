---
name: orchestrate
description: Split an approved task into parallel builders that each own a separate Git worktree and disjoint paths, then gate the integrated candidate. Use for work with independent parts and clear ownership.
argument-hint: <parent task.json>
disable-model-invocation: true
---

Coordinate parallel builders for: $ARGUMENTS

Separately green builders do not make a green application. Only the integrated candidate's gate counts.

1. Split the parent task into nodes. Each node is a complete task with the parent's `base_ref` and `allowed_paths` inside the parent's. Every builder starts from the approved base and must pass the gate there on its own, so a node cannot rely on another node's code: if two pieces only work together, they are one node. Nodes that own overlapping paths declare `depends_on`, which orders the merges. Keep shared contracts in one node.
2. Write the plan as `{ "schema_version": 1, "task": <parent>, "acceptance": <record>, "nodes": [{ "task": <node>, "acceptance": <record>, "depends_on": [] }] }`. Every task carries its acceptance record (draft each with `prepare`). Node records cite checks only; manual observations belong to the parent, on the integrated candidate. Show the plan and the mappings to the owner. The owner approves it once; approval pins `base_ref` to a commit SHA for every task in the plan:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/harness.mjs" approve-plan <plan.json>
```

3. Launch one `harness-builder` agent per node in a single message so they run concurrently. Each builder gets its own worktree. Give each one the harness CLI command (`node "${CLAUDE_PLUGIN_ROOT}/scripts/harness.mjs"`, written out as an absolute path) and its node task file (the path `approve-plan` printed), and tell it to activate with `--approved` before its first edit or commit, implement, run `verify`, commit on its branch, and report the branch name. Do not use shared-workspace agents to write code in parallel.
4. Inspect each builder's actual diff and gate result. A builder's report is not evidence. A failed or blocked builder stops the wave: bring its evidence to the owner.
5. Integrate the builder branches in dependency order and gate the combined candidate:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/harness.mjs" integrate <parent-id> --branch <node-id>=<branch> --branch <node-id>=<branch>
```

This creates a retained integration worktree and branch, activates the parent task there from the clean base, and refuses a branch with no commits. It never merges into the owner's branch. A conflict stops with the worktree kept for inspection.
6. Run `/harness:review` from the integration worktree, then present the gate result, the review findings, and the unresolved risks. The owner decides what merges.
