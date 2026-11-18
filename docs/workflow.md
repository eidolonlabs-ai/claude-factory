# Workflow

Commands below use `harness` for `node <plugin>/scripts/harness.mjs`. Inside Claude Code the skills run them for you.

## Task

A task is JSON with a base commit, allowed paths, and acceptance criteria. The format is shared with the sibling harnesses.

```json
{
  "schema_version": 1,
  "id": "trim-note-titles",
  "title": "Normalize note titles before saving",
  "specification": "Trim surrounding whitespace before saving a title. Reject whitespace-only titles.",
  "base_ref": "HEAD",
  "allowed_paths": ["src/title.mjs"],
  "acceptance_criteria": ["A whitespace-only title is rejected and no note is created."]
}
```

`/harness:intake` drafts one and asks about decisions that change scope or acceptance. A task file inside the working tree counts as a change, so either commit it with `base_ref: "HEAD"` (activation pins the commit that resolves to) or keep a SHA-pinned copy outside the working tree. Tests that prove the criteria are acceptance inputs: land them in the base commit, before activation.

## Activate

`/harness:activate tasks/<id>.json` is the owner's checkpoint. It refuses a placeholder base, allowed paths that overlap protected paths, and protected files that already differ from the base. It then freezes the task, the resolved base, and the current `harness.json` for this worktree.

State lives in the Git common directory under `harness/`: outside every working tree, shared by all worktrees, and covered by the guard's `.git/` rule. `/harness:activate off` archives the task.

## Verify

`harness verify` runs the gate on the worktree as it is. The first failure stops it, and steps not reached report `NOT_RUN`.

| Step | Fails when |
| --- | --- |
| `scope` | A changed path is outside the task's allowed paths or `policy.editable_paths`, or a protected path changed (status `blocked`: stop for the owner). |
| `frozen` | `harness.json` differs from the configuration frozen at activation. The gate always runs the frozen copy. |
| `hygiene` | A `.env` file or private key is tracked, or `.env` exists and is not ignored. |
| `verify:<name>` | A configured check exits non-zero. Checks are `argv` arrays run without a shell. |
| `compose:policy` | The Compose definition breaks an isolation rule. |
| `compose:health` | Services do not become healthy in time. |
| `compose:e2e` | The test service exits non-zero against the live stack. |
| `compose:cleanup` | The gate could not remove its own resources, or a container that existed before the gate, outside its project, changed state or disappeared while it ran. Unrelated Docker activity on the same daemon can trigger this; rerun the gate. |
| `diff-audit` | Changed lines contain a high-severity pattern: a private key or cloud credential, dynamic code execution, or SQL built by interpolation. |
| `candidate` | The candidate changed while the gate ran. |

`NOT_RUN` is never `PASS`. The gate passes only when nothing failed and `compose:e2e` actually ran and passed, so an unreachable Docker daemon fails acceptance. `holdouts` always reports `NOT_RUN` in this version.

Each run writes `result.json` and bounded logs to `<git-common-dir>/harness/runs/<run-id>/`. `harness status` says whether the last result still describes the current candidate.

## Review

`/harness:review` forks a fresh context running the `harness-reviewer` subagent with the output of `harness review-packet`: the task, the gate evidence (flagged if missing or stale), and the diff. The reviewer has no edit tools and none of the builder's conversation. Its findings are input for the owner; a collected review is not an approval.

## Parallel builders

`/harness:orchestrate` splits a parent task into nodes with disjoint paths. The owner approves the plan once with `harness approve-plan`, which rejects overlapping ownership without a dependency, paths outside the parent's, unknown dependencies, and cycles. Each node runs in a `harness-builder` subagent with its own worktree and activates its own task with `--approved`, which works only for tasks in an approved plan.

`harness integrate <parent-id> --branch <node>=<ref> ...` merges the builder branches in dependency order into a new worktree under `.claude/worktrees/`, activates the parent task there, and runs a fresh gate. It never touches the branch you are on, and it keeps the worktree on a conflict.

## Unattended

`harness run <task.json>` creates a worktree at the task's base, then repeats up to `limits.attempts` times: one headless `claude -p` session, then the gate, run by the controller outside the agent's session. A failed gate's summary becomes the next attempt's input. The run stops on a pass or on a protected change. Set `CLAUDE_HARNESS_CLAUDE_ARGS` to change the session's flags (default `--permission-mode acceptEdits`).
