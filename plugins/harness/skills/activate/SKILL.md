---
name: activate
description: Owner checkpoint that freezes an approved task for this worktree so the guard enforces its scope and the gate runs at completion. Also deactivates a finished or cancelled task.
argument-hint: <task.json> [acceptance.json] | off
disable-model-invocation: true
---

The owner invoked this checkpoint with: $ARGUMENTS

If the argument is `off`, run `deactivate` and report which task was archived.

Otherwise validate the task:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/harness.mjs" check-task <task.json>
```

Activation needs the task's acceptance record. If none was given, draft one with `prepare <task.json> --out <record>`. Show the owner the task's id, base commit, and allowed paths, and for each criterion what the record says proves it. The owner clears `unresolved_decisions` once they agree with the mapping; do not clear it for them without their explicit yes. Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/harness.mjs" activate <task.json> --acceptance <record.json>
```

Activation records the task, the mapping, the resolved base, and the current `harness.json` in the Git common directory, outside the working tree. It refuses a placeholder base, allowed paths that overlap protected paths, protected files that already differ from the base, and a record that leaves a criterion unmapped or a decision unresolved. Fix the cause it reports; do not work around it.

After activation, implement within the allowed paths. When the session stops, the gate boots the Compose stack and blocks completion until it passes or the attempt budget is spent.
