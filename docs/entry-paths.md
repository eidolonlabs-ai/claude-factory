# Start a development task (`claude-factory`)

Install the `factory` plugin (`/plugin marketplace add eidolonlabs-ai/claude-factory` and `/plugin install factory@claude-factory`), open your project in a fresh session, and start with `/factory:pipeline` (or invoke any stage command directly).

> **Shift-Left Habit:** Unattended `Stop`-hook loops and parallel `factory-builder` worktrees only succeed when requirements, edge cases, contracts, and adversarial tests are locked *before* implementation starts. If your request is underspecified, `/factory:intake` will push back rather than guessing.

## 1. Choose Your Entry Point (Minimum Inputs & Pushback Triggers)

| Starting point | Minimum inputs required | When the factory pushes back (`needs_clarification`) | First milestone |
| --- | --- | --- | --- |
| **1. New / Greenfield App** | Intended users, core journeys, stack constraints, data/API expectations, and any spec | Vague 1-liners, undefined endpoints/schemas, or unresolved **4-Part State & Edge-Case Matrix** domains | Run Plan Mode (`Shift+Tab`) + `factory-architect` on the 4-Part Matrix, lock `SPEC.md`/contracts + Compose healthchecks, land **Milestone 1.5 Frozen Adversarial Tests** in `tests/`, and activate via `/factory:plan`. |
| **2. Existing / Brownfield Repo** | Repo path, concrete goal, conventions, test commands, and known baseline failures | Missing Compose acceptance stack, unstated compatibility constraints, or unadopted `factory.json` | Preview & apply `/factory:setup`, preserve existing files, run baseline `factory verify`, and draft a scoped task JSON (`allowed_paths`). |
| **3. Bug Fix (Reproduce-First)** | Expected vs. actual behavior, reproduction steps, environment, and logs | Missing reproduction steps or request to patch immediately without a failing regression test | Capture a failing reproduction test first (**Reproduce Before Fixing**) in the base commit before activation, repair within `allowed_paths`, and rerun the full Compose + E2E gate. |
| **4. Feature / Behavior Change** | Desired behavior, exemplar files, API/DB compatibility constraints, and error handling | Unspecified schema/interface deltas or ambiguous acceptance criteria | Agree on interface/data changes and acceptance mapping (`factory prepare`), freeze regression tests in the base commit, and split disjoint child nodes in `/factory:plan` -> `/factory:build` when independent. |
| **5. Large-Scale Refactor / Migration** | Source/target patterns, invariant guarantees, rollout scope, and verification oracle | Missing baseline checks or overlapping file ownership across parallel nodes | Pin baseline acceptance tests, partition disjoint module nodes in a multi-node plan (`factory approve-plan`), and fan out `factory-builder` worktrees or Agent Teams before `factory integrate`. |

## 2. How to Choose Which Skill / Stage to Invoke

Start with **`/factory:pipeline`** whenever you want guided end-to-end orchestration from idea/request to verified diff. Invoke an individual `/factory:<stage>` command directly only when its upstream inputs are ready:

| Command | Invoke directly when… | What happens if prerequisites are missing (Pushback) |
| --- | --- | --- |
| **`/factory:pipeline`** | Default entry point for any full feature, greenfield build, bug fix, or refactor | Guides you through Phases 0–4 and refuses to jump into coding while intake/tests are missing |
| **`/factory:setup`** | Adopting a repository (`factory.json`, `.claude/settings.json` guards, baseline `factory verify`) | Refuses placeholder checks or mocked databases (`NOT_RUN !== PASS`) |
| **`/factory:intake`** | Evaluating a raw spec (`benchmarks/chronograph/input/original.md`) or drafting `tasks/<id>.json` + `factory prepare` | **Pushes back** in Plan Mode (`factory-architect`) one decision at a time across the 4-Part Matrix |
| **`/factory:plan`** | All intake blockers are resolved and you are ready to freeze Milestone 1.5 tests and run `factory activate` / `approve-plan` | **Refuses to activate** if base is unpinned, protected paths overlap, adversarial tests are missing, or `unresolved_decisions` remain |
| **`/factory:build`** | Task or multi-node plan is already activated/approved and frozen tests are landed | **Halts and routes back** to `/factory:intake` or `/factory:plan` if non-trivial tasks have no active task/frozen tests |
| **`/factory:verify`** | Running the external Compose + E2E gate (`NOT_RUN !== PASS`) and Desktop Browser check (`Cmd+Shift+B`) | Fails closed on scope violations, unavailable Docker, missing tests, or unrecorded manual evidence (`PENDING`) |
| **`/factory:review`** | Running cold-context `factory-reviewer` over `factory review-packet` after `/factory:verify` passes | Refuses review approval when gate evidence is missing/stale; enforces **Reproduce Before Fixing** for every bug |
| **`/factory:status`** | Checking active task scope, attempt budget, and candidate digest freshness | Flags stale/missing gates and exhausted budgets as unverified |
