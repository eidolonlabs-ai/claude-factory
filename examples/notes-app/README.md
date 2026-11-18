# Notes app (harness demo)

A disposable application for trying the harness. The baseline stores note titles exactly as submitted, and the acceptance test in `acceptance/e2e.mjs` requires trimmed titles and rejection of whitespace-only ones, so the baseline gate fails.

`scripts/demo.sh` in the repository root copies this directory to a temporary Git repository and walks through a guard denial, a failing gate, and a passing gate after the repair, on a real Docker Compose stack.

To try it by hand, copy the directory somewhere, run `git init` and commit everything (the task's `base_ref` is `HEAD`, which activation pins to that commit), then use `/harness:activate tasks/trim-note-titles.json` in Claude Code and ask for the task.
