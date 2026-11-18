---
name: setup
description: Adopt Claude Harness in a new or existing Git project without overwriting its configuration. Use after installing the plugin, or when harness.json or the Compose acceptance stack is missing.
disable-model-invocation: true
---

Adopt the harness in this project. Existing files belong to the owner and are never overwritten.

1. Check the environment and preview the scaffold:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/harness.mjs" doctor
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/harness.mjs" setup
```

2. Show the owner the preview. Apply it with `setup --apply` once they agree.
3. Inspect the project's stack, run commands, and existing tests. With the owner, edit `harness.json` so that `compose.files` and `compose.services` name the real services the application needs, `compose.test_service` runs end-to-end tests against those live services over the Compose network, `policy.protected_paths` covers every acceptance input (tests, Dockerfiles, test-runner configuration, dependency manifests), and `policy.editable_paths` covers application code.
4. The gate rejects fixed `container_name`, published host ports, privileged containers, the Docker socket, bind mounts outside the project, and external networks or volumes. Each service the test depends on needs a healthcheck. Keep development-only port mappings in a separate override file.
5. If the project has no acceptance stack yet, say so. Never substitute a placeholder command, a mocked database, or a skipped test to get a pass; ask the owner what the application must demonstrably do.
6. Merge `docs/harness/CLAUDE.snippet.md` into `CLAUDE.md` and the suggested permission rules into `.claude/settings.json` after the owner reviews them. The permission rules are the enforcement boundary; the hooks catch honest mistakes early.
7. Commit the configuration, then establish the baseline:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/harness.mjs" verify
```

Report exactly which checks ran and which did not. A baseline that cannot pass is the first task.
