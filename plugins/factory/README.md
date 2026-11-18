# factory

Scoped tasks, hook guards, and a real Docker Compose acceptance gate for Claude Code.

```
/plugin marketplace add eidolonlabs-ai/claude-factory
/plugin install factory@claude-factory
```

Open a project in a fresh session and run `/factory:pipeline` (or step through `/factory:setup`, `/factory:intake`, `/factory:plan`, `/factory:build`, `/factory:verify`, `/factory:review`, and `/factory:status`).

Unlike plain prompts/skills—which can skip tests, drift, or guess through vague prompts—Claude Factory shifts work upfront: `/factory:intake` (`factory-architect` in Plan Mode) pushes back on ambiguous requirements across the 4-Part Matrix, `/factory:plan` freezes contracts and Milestone 1.5 tests at activation, hooks guard edits and gate `Stop` completion on real Compose stacks, `/factory:build` runs single or parallel worktrees, and `/factory:review` provides cold-context review before shipping.

Requires Node.js 20+, Git, and Docker with Compose v2. The hooks stay silent in repositories without `factory.json`.

Documentation: <https://github.com/eidolonlabs-ai/claude-factory>
