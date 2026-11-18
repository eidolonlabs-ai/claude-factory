# Install and adopt the plugin

The plugin bundles skills, subagents, hooks, and a dependency-free Node runtime. Verification needs Node.js 20+, Git, and Docker with Compose v2. Unattended `run` also needs an authenticated `claude` CLI.

## Install

From GitHub, inside Claude Code:

```
/plugin marketplace add theRealMarkCastillo/claude-harness
/plugin install harness@claude-harness
```

From a local checkout, pass its path to `/plugin marketplace add`, or load it for one session without installing:

```bash
claude --plugin-dir /path/to/claude-harness/plugins/harness
```

Start a fresh session after installing. The plugin's hooks stay silent in any repository that has no `harness.json`.

## Update

```
/plugin marketplace update claude-harness
```

The version is set in `plugins/harness/.claude-plugin/plugin.json`. Review changed hook definitions after an update: they run with your permissions.

## Adopt a project

Run `/harness:setup`, or from a terminal:

```bash
node /path/to/plugins/harness/scripts/harness.mjs setup
```

```bash
node /path/to/plugins/harness/scripts/harness.mjs setup --apply
```

Setup previews first and never overwrites an existing file. It adds:

| File | Purpose |
| --- | --- |
| `harness.json` | Compose files, services, the test service, and the protection policy. Same format as the family's v3 config. |
| `.claude/settings.json` | Permission deny rules for secrets and `git push`. Written only if absent; otherwise a suggestion lands in `docs/harness/`. Rules for `harness.json` and acceptance inputs are added last, after the configuration is committed, because they also bind Claude. |
| `docs/harness/CLAUDE.snippet.md` | Instructions to merge into `CLAUDE.md` after review. |
| `tasks/example.json` | The task format. |
| `.gitignore` entries | `.env` files, local settings, `.claude/worktrees/`, and `tasks/drafts/` for task and acceptance drafts. |

Then make `harness.json` describe your real stack. The gate rejects a fixed `container_name`, published host ports, privileged containers, the Docker socket, bind mounts outside the project, and external networks or volumes, and it needs a healthcheck on each service the test depends on. Run `harness verify` to establish the baseline before the first task.

## What ships

| Component | Names |
| --- | --- |
| Skills | `/harness:setup`, `/harness:intake`, `/harness:activate`, `/harness:verify`, `/harness:status`, `/harness:review`, `/harness:orchestrate` |
| Subagents | `harness-architect` (read-only intake), `harness-builder` (own worktree), `harness-reviewer` (fresh context, no edit tools) |
| Hooks | `SessionStart`, `PreToolUse`, `Stop`, `SubagentStop` |
| Runtime | `scripts/harness.mjs` (CLI) and `scripts/hook.mjs` (hook entry) |

## Publish

The repository is its own marketplace: `.claude-plugin/marketplace.json` lists the plugin at `./plugins/harness`, so pushing to GitHub is enough for the install commands above. Before a release, bump the version, then run `npm test`, `HARNESS_E2E=1 npm test`, `bash scripts/demo.sh`, and `npm run validate`.

Plugin names beginning with `claude-` are reserved, which is why the plugin is named `harness` while the repository keeps its name. Submitting to Anthropic's plugin directory additionally needs a square PNG icon at `plugins/harness/.claude-plugin/icon.png` and passes through their safety and policy review.
