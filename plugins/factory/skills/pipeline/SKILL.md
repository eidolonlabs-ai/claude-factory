---
name: pipeline
description: End-to-end 5-phase Claude Factory orchestrator that shifts work upfront—pushing back on insufficient specs in `/factory:intake`, freezing contracts and Milestone 1.5 tests in `/factory:plan`, then running isolated builds, Compose verification, cold-context review, and status reporting.
argument-hint: "[project idea, repo goal, bug report, feature request, or spec path]"
disable-model-invocation: true
---

Coordinate the 5-phase Claude Factory workflow end-to-end for: $ARGUMENTS

Never collapse scoping, test/contract freeze, execution, verification, and independent review into an unverified pass. **Shift-Left Rule:** Refuse to advance to `/factory:build` until `/factory:intake` has resolved all ambiguities (pushing back on thin prompts) and `/factory:plan` has frozen contracts and failing Milestone 1.5 adversarial tests in the pinned base commit.

## Phase 0: Workspace Setup (`/factory:setup`)

- Run `/factory:setup` if `factory.json` or `.claude/settings.json` guards are missing.
- Enforce context hygiene: redirect heavy build/test logs to `/tmp/*.log` (`cmd > /tmp/run.log 2>&1 || tail -n 40 /tmp/run.log`) and use background subagents for deep codebase exploration.

## Phase 1: Read-Only Intake & Edge-Case Interview (`/factory:intake`)

- Run `/factory:intake` in **Plan Mode** (`Shift + Tab`), delegating long/contradictory specs to `factory-architect`.
- Route by developer starting point (**1. New Project**, **2. Existing Repo**, **3. Bug Fix [Reproduce-First]**, **4. Feature/Behavior Change**, **5. Refactor/Migration**).
- Interview one question at a time across the **4-Part State & Edge-Case Matrix**:
  1. Out-of-order & duplicate inputs (`idempotency_key`, backdated updates, retries)
  2. Concurrency & race conditions (`SELECT FOR UPDATE`, optimistic versions, UI `AbortController` + sequence counters)
  3. Clock & timezone boundaries (UTC ISO-8601 at rest, explicit `as_of` cursors vs `now()`)
  4. Dual-write & cross-service atomicity (commit ordering, stale edge deletion before `MERGE`)
- Produce `tasks/<id>.json` and `factory prepare` acceptance mapping. Stop while blocking decisions remain open.

## Phase 2: Contracts, Frozen Adversarial Tests & Activation (`/factory:plan`)

- Lock `SPEC.md`, API contracts, `docker-compose.yml` healthchecks, and **Milestone 1.5 Frozen Adversarial Tests** in `tests/` / `acceptance/` (happy paths + all 4 edge-case matrix failures, using explicit `data-testid` attributes).
- Confirm the adversarial tests fail as expected before writing application code, commit acceptance inputs to the base commit, and activate via `/factory:plan` (`factory activate` or `factory approve-plan`).

## Phase 3: Isolated Execution (`/factory:build`)

Choose the execution mode via `/factory:build`:
- **Option A (Single-Session `Stop`-Hook Goal Loop)**: Work in the activated workspace; the `Stop` hook runs `factory verify` on turn exit and feeds failures back until exit 0 or attempt exhaustion.
- **Option B (Parallel Worktree Subagents / Agent Teams)**: Launch `factory-builder` worktree subagents (or `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) across disjoint slices and merge with `factory integrate`.
- **Option C (Unattended Phased Watchdog)**: Run `factory run <task.json> --acceptance <record.json>` for fresh-context `claude -p` milestone loops outside the desktop context.

## Phase 4: Verify, Cold-Context Review & Status

1. **`/factory:verify`**: Run the external Docker Compose + E2E gate (`NOT_RUN !== PASS`), inspect live UI flows in the Desktop Browser pane (`Cmd+Shift+B` / `Ctrl+Shift+B`), and record owner manual observations (`factory evidence`) when required.
2. **`/factory:review`**: Run cold-context `factory-reviewer` over `factory review-packet` (`git diff main...HEAD`). Enforce **Reproduce Before Fixing**: capture a failing test for any bug before patching, then re-verify.
3. **`/factory:status`**: Summarize active scope, fresh gate evidence, review findings, and next owner action before committing or merging.
