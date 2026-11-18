# Install and adopt the plugin

The plugin bundles skills, subagents, hooks, and a dependency-free Node runtime. Verification needs Node.js 20+, Git, and Docker with Compose v2. Unattended `run` also needs an authenticated `claude` CLI.

## Install

From GitHub, inside Claude Code:

```
/plugin marketplace add eidolonlabs-ai/claude-factory
/plugin install factory@claude-factory
```

From a local checkout, pass its path to `/plugin marketplace add`, or load it for one session without installing:

```bash
claude --plugin-dir /path/to/claude-factory/plugins/factory
```

Start a fresh session after installing. The plugin's hooks stay silent in any repository that has no `factory.json`.

## Update

```
/plugin marketplace update claude-factory
```

The version is set in `plugins/factory/.claude-plugin/plugin.json`. Review changed hook definitions after an update: they run with your permissions.

## Adopt a project

Run `/factory:setup`, or from a terminal:

```bash
node /path/to/plugins/factory/scripts/factory.mjs setup
```

```bash
node /path/to/plugins/factory/scripts/factory.mjs setup --apply
```

Setup previews first and never overwrites an existing file. It adds:

| File | Purpose |
| --- | --- |
| `factory.json` | Compose files, services, the test service, and the protection policy. Same format as the family's v3 config. |
| `.claude/settings.json` | Permission deny rules for secrets and `git push`. Written only if absent; otherwise a suggestion lands in `docs/factory/`. Rules for `factory.json` and acceptance inputs are added last, after the configuration is committed, because they also bind Claude. |
| `docs/factory/CLAUDE.snippet.md` | Instructions to merge into `CLAUDE.md` after review. |
| `tasks/example.json` | The task format. |
| `.gitignore` entries | `.env` files, local settings, `.claude/worktrees/`, and `tasks/drafts/` for task and acceptance drafts. |

Then make `factory.json` describe your real stack. The gate rejects a fixed `container_name`, published host ports, privileged containers, the Docker socket, bind mounts outside the project, and external networks or volumes, and it needs a healthcheck on each service the test depends on. Run `factory verify` to establish the baseline before the first task.

## What ships

| Component | Names |
| --- | --- |
| Skills | `/factory:setup`, `/factory:intake`, `/factory:activate`, `/factory:verify`, `/factory:status`, `/factory:review`, `/factory:orchestrate` |
| Subagents | `factory-architect` (read-only intake), `factory-builder` (own worktree), `factory-reviewer` (fresh context, no edit tools) |
| Hooks | `SessionStart`, `PreToolUse`, `Stop`, `SubagentStop` |
| Runtime | `scripts/factory.mjs` (CLI) and `scripts/hook.mjs` (hook entry) |

## Publish

The repository is its own marketplace: `.claude-plugin/marketplace.json` lists the plugin at `./plugins/factory`, so pushing to GitHub is enough for the install commands above. Before a release, bump the version, then run `npm test`, `FACTORY_E2E=1 npm test`, `bash scripts/demo.sh`, and `npm run validate`.

Plugin names beginning with `claude-` are reserved, which is why the plugin is named `factory` while the repository keeps its name. Submitting to Anthropic's plugin directory additionally needs a square PNG icon at `plugins/factory/.claude-plugin/icon.png` and passes through their safety and policy review.
