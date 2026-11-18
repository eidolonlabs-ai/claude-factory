# Claude Factory

A local development factory for [Claude Code](https://code.claude.com/docs), packaged as the `factory` plugin. It turns a request into a scoped task, guards edits while Claude works, and decides "done" by exit codes on a real Docker Compose stack. The owner reviews the evidence and decides when to ship.

## Why Prompts & Skills Alone Fail vs. This Software Factory

Plain prompts and standalone skills are **probabilistic**—over long tasks, agents claim "done" without booting real services, flood their context window with verbose logs, weaken failing tests to force green builds, or stall on `[y/n]` confirmation prompts. **Claude Factory** keeps Claude's Unix-native ergonomics while adding **deterministic runtime physics**:

| Layer | Nature | What It Provides Here |
| --- | --- | --- |
| **1. Prompt Engineering** | Probabilistic (Single Turn) | 8 `/factory:<stage>` skills (`pipeline` through `status`) and 3 roles (`factory-architect`, `factory-builder`, `factory-reviewer`) |
| **2. Context Engineering** | Probabilistic (Session State) | `CLAUDE.md`, `.claude/settings.json` permission rules, `/tmp/*.log` hygiene, and `SessionStart` active-task injection across compaction |
| **3. Factory / Harness Engineering** | Deterministic (Runtime Physics) | `PreToolUse` scope/secret/frozen-input guards, `Stop` / `SubagentStop` real-stack Compose gates (`NOT_RUN !== PASS`), bounded retry budgets, isolated `.claude/worktrees/`, `diff-audit`, and cold-context `factory-reviewer` |

| Unattended Failure Mode | Why Prompts/Skills Alone Fail | How Claude Factory Solves It Deterministically |
| --- | --- | --- |
| **Premature "Done" Claims** | Model declares success from partial unit tests or guesses | `Stop` / `SubagentStop` hooks run `factory verify` on a real Docker Compose + E2E stack (`NOT_RUN !== PASS`) |
| **Context Window Rot** | Raw Docker/test output fills context and erases constraints | `/tmp/*.log` tailing, background exploration, worktree subagents (`factory-builder`), and fresh-context `factory-reviewer` |
| **Test-Cheating / Weakened Assertions** | Model edits tests or config to pass failing gates | **Milestone 1.5 Frozen Adversarial Tests** committed to the pinned base + `PreToolUse` / `.claude/settings.json` deny rules on `tests/`, Compose files, and `factory.json` |
| **HIL Permission Fatigue** | Interactive prompts interrupt autonomous execution loops | Scoped `allowed_paths` + isolated worktrees (`factory-builder`) allow safe autonomous loops with hard `PreToolUse` guardrails |

## Shift-Left Engineering: Built-In Spec Pushback

Unattended `Stop`-hook self-healing and parallel `factory-builder` worktrees only succeed when engineering rigor happens **upfront**:

- **Mandatory Intake Pushback (`/factory:intake`)**: If your prompt is vague, lacks error/boundary behavior, or leaves any **4-Part State & Edge-Case Matrix** domain unresolved (out-of-order/duplicates, concurrency/row locks & `AbortController`, UTC/`as_of` clock bounds, dual-write atomicity), `/factory:intake` (`factory-architect` in Plan Mode) **pushes back** (`needs_clarification`), interviewing you one decision at a time instead of guessing.
- **Refusal to Build Unfrozen Tasks (`/factory:plan` → `/factory:build`)**: `/factory:plan` refuses to activate a task until blocking decisions are resolved, `SPEC.md`/Compose healthchecks are locked, and failing **Milestone 1.5 Frozen Adversarial Tests** (or bug reproduction tests) sit in the pinned base commit. `/factory:build` halts and routes back to `/factory:intake` / `/factory:plan` if called on a non-trivial task without an activated task and frozen tests.

## How to Choose Your Entry Point & Stage

Start with **`/factory:pipeline`** for guided Phase 0–4 execution across all 5 starting points (see [entry paths](docs/entry-paths.md) for minimum inputs and pushback triggers):

| Entry Point | Minimum Inputs | When `/factory:intake` Pushes Back |
| --- | --- | --- |
| **1. New / Greenfield App** | Users, core journeys, stack constraints, data/API expectations | Ambiguous entities/endpoints or unresolved 4-Part Matrix edge cases |
| **2. Existing / Brownfield Repo** | Repo path, concrete goal, conventions, test commands, baseline failures | Missing Compose acceptance stack or unstated compatibility constraints |
| **3. Bug Fix (Reproduce-First)** | Expected vs. actual behavior, repro steps, environment/logs | Missing reproduction steps or request to skip landing a failing regression test first |
| **4. Feature / Behavior Change** | Desired behavior, exemplar files, schema/API compatibility constraints | Unclear interface deltas, error states, or acceptance criteria |
| **5. Refactor / Migration** | Source/target patterns, invariants, rollout scope, verification oracle | Missing baseline tests or overlapping multi-node file ownership |

| Phase | Command | When to Invoke Directly |
| --- | --- | --- |
| **All (E2E)** | `/factory:pipeline` | Default entry point guiding Phases 0–4 with built-in intake and freeze pushback |
| **Phase 0** | `/factory:setup` | Adopting a repo (`factory.json`, `.claude/settings.json` deny rules, `/tmp/*.log` hygiene, baseline `verify`) |
| **Phase 1** | `/factory:intake` | Evaluating a spec (`benchmarks/chronograph/input/original.md`) or drafting `tasks/<id>.json` + `factory prepare` |
| **Phase 2** | `/factory:plan` | Intake is resolved; ready to freeze Milestone 1.5 tests and run `factory activate` / `approve-plan` |
| **Phase 3** | `/factory:build` | Task/plan is frozen; run `Stop`-hook loop, parallel `factory-builder` worktrees / Agent Teams, or `claude -p` (`factory run`) |
| **Phase 4A** | `/factory:verify` | Running the external Compose + E2E gate (`NOT_RUN !== PASS`), Desktop Browser check (`Cmd+Shift+B`), or `factory evidence` |
| **Phase 4B** | `/factory:review` | Running cold-context `factory-reviewer` over `factory review-packet` (**Reproduce Before Fixing**) |
| **Inspect** | `/factory:status` | Checking active task scope, attempt budget, and candidate digest freshness |

## Install

Requires Claude Code, Node.js 20+, Git, and Docker with Compose v2.

```
/plugin marketplace add eidolonlabs-ai/claude-factory
/plugin install factory@claude-factory
```

Start a fresh session, open your project, and run `/factory:pipeline` or `/factory:setup`. [Installing and adopting](docs/plugin.md) covers local checkouts, updates, and what adoption changes. See [5 entry points](docs/entry-paths.md) and the [ChronoGraph official benchmark](benchmarks/chronograph/README.md).

## Try it

```bash
bash scripts/demo.sh
```

The demo uses [examples/notes-app](examples/notes-app) (a fast smoke fixture, not a benchmark) copied to a temporary repository and shows a guard denial, a failing gate on an incomplete fix, and a passing gate after the repair. It needs a running Docker daemon.

## Read next

- [Entry points](docs/entry-paths.md): New project, Existing repo, Bug fix, Feature, Refactor/Migration
- [ChronoGraph benchmark](benchmarks/chronograph/README.md): Shared intake and build yardstick
- [Design outline](docs/design.md) and milestone status
- [Workflow](docs/workflow.md): tasks, activation, verification, review, parallel builders, unattended runs
- [Hooks and trust boundaries](docs/hooks.md)
- [Family contract](CONTRACT.md) shared with the sibling factories

## Develop

```bash
npm test
```

```bash
FACTORY_E2E=1 npm test
```

```bash
npm run validate
```

The plugin source is [plugins/factory](plugins/factory); it has no dependencies and no build step. Skills under `plugins/factory/skills/<stage>/SKILL.md` unify Claude Code's progressive-disclosure skills and `/factory:<stage>` slash commands (no duplicate `commands/` folder), share the bundled CLI in `plugins/factory/scripts/factory.mjs`, and coordinate parallel `factory-builder` worktree slices via `approve-plan` / `integrate`. The first test command runs unit tests and every case in `contract/guard-cases.json`; `FACTORY_E2E=1 npm test` adds live Compose E2E tests; `npm run validate` runs strict plugin + marketplace checks (`0` warnings with `.claude-plugin/icon.png`); and `npm run package:plugin` builds a release tarball in `dist/`.

## Related factories

- [Antigravity Factory](https://github.com/eidolonlabs-ai/antigravity-factory)
- [Codex Factory](https://github.com/eidolonlabs-ai/codex-factory)
- [Hermes Factory](https://github.com/eidolonlabs-ai/hermes-factory)

[MIT license](LICENSE)
