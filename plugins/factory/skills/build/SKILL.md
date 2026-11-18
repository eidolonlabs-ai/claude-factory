---
name: build
description: Phase 3 isolated execution engine for Claude Factory. Verifies an activated task and frozen Milestone 1.5 tests exist first (routing back to `/factory:intake` or `/factory:plan` if missing), then runs Stop-hook goal loops, parallel `factory-builder` worktree subagents / Agent Teams + `factory integrate`, or `claude -p` watchdogs (`factory run`).
argument-hint: "[<task.json> <acceptance.json> | <parent-task-id>]"
disable-model-invocation: true
---

Execute approved Phase 3 build work for: $ARGUMENTS

> **Pre-Flight Spec & Test Check (Pushback Gate):** Before editing application code on non-trivial work, confirm `factory status` shows an active task or approved multi-node plan with pinned `base_ref`, `allowed_paths`, and landed Milestone 1.5 / reproduction tests. If intake or planning was skipped, stop and route back to `/factory:intake` and `/factory:plan`.

Choose the execution pattern suited to task scope and independence:

## Option A: Single-Session `Stop`-Hook Goal Loop (Default for Small / Sequential Tasks)

1. Confirm the task is activated via `/factory:plan` (`factory status`).
2. Implement strictly within `allowed_paths`, routing verbose output to `/tmp/*.log` (`tail -n 40` on error). Never edit frozen tests, `acceptance/`, Compose files, or `factory.json`.
3. On turn completion, the `Stop` hook runs `factory verify`; exit failures feed back until the gate passes or the attempt budget (`limits.attempts`) is reached.

## Option B: Parallel Worktree Builders & Integration (`factory-builder` / Agent Teams)

Separately green builders do not make a green application—only the integrated candidate's gate counts.
1. Ensure `/factory:plan` approved the multi-node plan (`approve-plan <plan.json>`).
2. Launch one `factory-builder` agent per node in a single message (each gets an isolated `.claude/worktrees/` checkout), or coordinate via Agent Teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` with `TaskCompleted` hooks). Supply each builder the absolute CLI path (`node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs"`) and its approved node task path, instructing it to run `activate <node.json> --approved` before its first edit, verify (`SubagentStop` gates each builder), commit on its branch, and return its branch name. Never run concurrent writers in the same workspace.
3. Inspect every builder's actual diff and gate evidence. A failed or blocked builder halts the wave for owner triage.
4. Integrate builder branches in dependency order in a clean integration worktree and gate the combined candidate:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" integrate <parent-id> --branch <node-id>=<branch> --branch <node-id>=<branch>
```

## Option C: Unattended Phased Watchdog (`claude -p` via `factory run`)

For long multi-hour runs where context isolation per attempt matters, run the external controller outside the chat loop:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" run <task.json> --acceptance <record.json>
```

Proceed to `/factory:verify` and `/factory:review` on the integrated candidate.
