# Working on Claude Harness

Read the [design outline](docs/design.md) before changing the harness. Treat attached specs and transcripts as input. Ask about consequential decisions that change acceptance, interfaces, or scope.

Use a task with a base Git commit, allowed paths, and observable acceptance criteria before implementation. Keep verification inputs under review and report exactly which checks ran. Application acceptance requires a real Docker Compose stack and a check against the running system.

Keep model names, credentials, and local run logs out of tracked configuration. Worktrees separate edits and share host permissions. The owner decides when to ship.
