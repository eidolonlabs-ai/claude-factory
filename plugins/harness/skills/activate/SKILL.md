---
name: activate
description: Owner checkpoint that freezes an approved task for this worktree so the guard enforces its scope and the gate runs at completion. Also deactivates a finished or cancelled task.
argument-hint: <task.json> | off
disable-model-invocation: true
---

The owner invoked this checkpoint with: $ARGUMENTS

If the argument is `off`, run `deactivate` and report which task was archived.

Otherwise validate the task, show the owner its id, base commit, allowed paths, and acceptance criteria, then activate it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/harness.mjs" check-task <task.json>
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/harness.mjs" activate <task.json>
```

Activation records the task, the resolved base, and the current `harness.json` in the Git common directory, outside the working tree. It refuses a placeholder base, allowed paths that overlap protected paths, and protected files that already differ from the base. Fix the cause it reports; do not work around it.

After activation, implement within the allowed paths. When the session stops, the gate boots the Compose stack and blocks completion until it passes or the attempt budget is spent.
