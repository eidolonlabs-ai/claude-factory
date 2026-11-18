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

Run `/factory:pipeline` (or `/factory:setup` first on an unadopted project), or from a terminal:

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

| Component | Names & Layout |
| --- | --- |
| Skills / Commands | `plugins/factory/skills/<stage>/SKILL.md` exposes `/factory:pipeline`, `/factory:setup`, `/factory:intake`, `/factory:plan`, `/factory:build`, `/factory:verify`, `/factory:review`, `/factory:status` |
| Subagents | `factory-architect` (read-only intake), `factory-builder` (own worktree), `factory-reviewer` (fresh context, no edit tools) |
| Hooks | `SessionStart`, `PreToolUse`, `Stop`, `SubagentStop` (`hooks/hooks.json`) |
| Bundled Scripts & Lib | `scripts/factory.mjs` (CLI) and `scripts/hook.mjs` (hook entry) backed by `lib/*.mjs` |
| Manifest & Icon | `.claude-plugin/plugin.json` and 512x512 `.claude-plugin/icon.png` |

### Skills vs. Slash Commands & Bundled Scripts

Since Claude Code **v2.1.3+**, slash commands and `skills/<name>/SKILL.md` are **unified**—each skill folder under `plugins/factory/skills/<stage>/SKILL.md` is automatically both an agent-discoverable progressive-disclosure skill and the namespaced `/factory:<stage>` slash command (a separate legacy `commands/` directory is unnecessary and would duplicate definitions). Rather than copying scripts inside each skill folder, all 8 skills invoke the shared deterministic runtime at `${CLAUDE_PLUGIN_ROOT}/scripts/factory.mjs` (and hooks invoke `${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs`).

### Parallel Implementation Slices

For multi-module tasks, `/factory:plan` validates a plan DAG via `factory approve-plan` with disjoint `allowed_paths` slices per node, and `/factory:build` spawns isolated `factory-builder` subagents in separate `.claude/worktrees/` directories gated by `SubagentStop` and merged via `factory integrate`.

## Publish & Distribute

The repository is its own GitHub marketplace: [.claude-plugin/marketplace.json](../.claude-plugin/marketplace.json) indexes `./plugins/factory`, enabling direct installation via `/plugin marketplace add eidolonlabs-ai/claude-factory` and `/plugin install factory@claude-factory`. Plugin names beginning with `claude-` are reserved, which is why the plugin is named `factory` while the repository keeps `claude-factory`. Before a release or marketplace submission, bump `plugins/factory/.claude-plugin/plugin.json`, ensure `.claude-plugin/icon.png` (512x512 PNG) is present, and run `npm test`, `FACTORY_E2E=1 npm test`, `bash scripts/demo.sh`, `npm run validate`, and `npm run package:plugin` (emits a release tarball and SHA-256 inventory under `dist/`).
