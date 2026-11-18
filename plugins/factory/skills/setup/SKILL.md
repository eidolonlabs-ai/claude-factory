---
name: setup
description: Phase 0 workspace adoption for Claude Factory in a new or existing Git project without overwriting its configuration. Use after installing the plugin, or when factory.json or the Compose acceptance stack is missing.
disable-model-invocation: true
---

Adopt Claude Factory in this project (Phase 0). Existing files belong to the owner and are never overwritten.

1. Check the environment and preview the scaffold:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" doctor
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" setup
```

2. Show the owner the preview. Apply it with `setup --apply` once they agree.
3. Inspect the project's stack, run commands, and existing tests. Edit `factory.json` yourself and show the owner the result, so that `compose.files` and `compose.services` name the real services the application needs, `compose.test_service` runs end-to-end tests against those live services over the Compose network, `policy.protected_paths` covers every acceptance input (tests, Dockerfiles, test-runner configuration, dependency manifests), and `policy.editable_paths` covers application code.
4. The gate rejects fixed `container_name`, published host ports, privileged containers, the Docker socket, bind mounts outside the project, and external networks or volumes. Each service the test depends on needs a healthcheck. Keep development-only port mappings in a separate override file.
5. If the project has no acceptance stack yet, say so. Never substitute a placeholder command, a mocked database, or a skipped test to get a pass; ask the owner what the application must demonstrably do.
6. Merge `docs/factory/CLAUDE.snippet.md` into `CLAUDE.md` after the owner reviews it, and adopt context hygiene rules: redirect heavy build/test logs to `/tmp/*.log` (`cmd > /tmp/run.log 2>&1 || tail -n 40 /tmp/run.log`).
7. Commit the configuration. `factory.json` stays editable until a task is frozen in `/factory:plan`; activation freezes it and the gate blocks any later change.
8. Only now, as the last edit, propose permission deny rules in `.claude/settings.json` for the acceptance inputs you listed in `policy.protected_paths` and for `factory.json` (for example `Edit(./factory.json)`, `Edit(./acceptance/**)`). These rules take effect immediately and apply to you too, so adding them earlier locks you out of the files you still need to write. Do not deny paths you will have to create or change later, such as documentation. The permission rules are the enforcement boundary; the hooks catch honest mistakes early.
9. Configure execution ergonomics when running long autonomous tasks: enable `autoCompactWindow: true` (and `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` if parallel Agent Teams are desired), open the Desktop Browser pane (`Cmd+Shift+B` / `Ctrl+Shift+B`) for localhost inspection, and establish the baseline:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs" verify
```

With no task active this is a baseline run: it reports `BASELINE` and exits 3 when the stack and its test pass, and it is never acceptance evidence. Report exactly which checks ran and which did not (`NOT_RUN !== PASS`). A baseline that cannot pass is the first task.
