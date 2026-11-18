# factory

Scoped tasks, hook guards, and a real Docker Compose acceptance gate for Claude Code.

```
/plugin marketplace add eidolonlabs-ai/claude-factory
/plugin install factory@claude-factory
```

Open a project in a fresh session and run `/factory:setup`. Then `/factory:intake` drafts a task, `/factory:activate` freezes it, the hooks guard edits and gate completion, and `/factory:review` gives the owner an independent read before shipping.

Requires Node.js 20+, Git, and Docker with Compose v2. The hooks stay silent in repositories without `factory.json`.

Documentation: <https://github.com/eidolonlabs-ai/claude-factory>
