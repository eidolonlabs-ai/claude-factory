# harness

Scoped tasks, hook guards, and a real Docker Compose acceptance gate for Claude Code.

```
/plugin marketplace add theRealMarkCastillo/claude-harness
/plugin install harness@claude-harness
```

Open a project in a fresh session and run `/harness:setup`. Then `/harness:intake` drafts a task, `/harness:activate` freezes it, the hooks guard edits and gate completion, and `/harness:review` gives the owner an independent read before shipping.

Requires Node.js 20+, Git, and Docker with Compose v2. The hooks stay silent in repositories without `harness.json`.

Documentation: <https://github.com/theRealMarkCastillo/claude-harness>
