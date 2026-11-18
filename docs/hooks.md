# Hooks and trust boundaries

The plugin registers four hooks. All of them exit silently unless the repository contains `harness.json`.

| Hook | Behavior |
| --- | --- |
| `SessionStart` | Adds the active task, its allowed paths, and the attempt count to Claude's context, including after compaction. |
| `PreToolUse` on `Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit` | Returns `deny` or `ask` as a permission decision. |
| `Stop` | Runs the gate for the active task when the candidate has changed since the last pass. A failure blocks the stop and hands Claude the failing checks. |
| `SubagentStop` for `harness-builder` | Runs the same gate in the builder's worktree. |

## Guard

Always, in an adopted repository:

- **Deny** writes to any file whose name starts with `.env` (except `.env.example`, `.env.sample`, `.env.template`, `.env.test`), private keys, `.git/`, the `.harness/` control directory, and holdout files.
- **Deny** `rm` of the filesystem root or home, `mkfs`, fork bombs, `git push`, `--no-verify`, host-wide `docker ... prune`, and downloads piped into a shell.
- **Ask** for `git reset --hard`, `git clean -f`, interactive rebase, and the owner checkpoints `harness activate`, `deactivate`, `approve-plan`, and `evidence`. These become **deny** in `bypassPermissions` and `dontAsk` modes and in managed runs.

While a task is active, also deny writes outside its allowed paths, to protected paths, and to `harness.json`. Before activation `harness.json` is editable, because setup has to write it; activation freezes it and refuses if it differs from the base.

Shell commands are read for writes: redirects, `tee`, `cp`/`mv`/`ln` (including `-t`), `sed -i`, `dd of=`, `rm`, `rsync`, `find -delete`, `curl -o`, `tar -C`, `git checkout`/`restore`, and the same forms inside `sh -c`, `$(...)`, backticks, and after `cd`. Heredoc bodies are data. Names are compared without regard to case. While a task is active, git-ignored paths such as `node_modules` are exempt from the scope rule. The guard passes every case in the family's [guard-cases.json](../contract/guard-cases.json); `npm test` runs them.

## Stop gate

A failed gate increments the task's attempt count. After `limits.attempts` failures (default 3) the hook stops blocking, so a session cannot loop forever. From then on every stop tells the owner the task is blocked and that later changes are unverified, and the next session's context says the same. A passing `harness verify` clears the count. A change to a protected path or to `harness.json` blocks with an instruction to revert or ask the owner.

A gate that cannot run verifies nothing, so it also blocks the stop: a lock held by another gate in the same worktree, an unresolvable base, or an internal error. These failures, and ones caused by other activity on the Docker daemon, have their own budget of the same size and do not use up the candidate's attempts.

The Stop hook's timeout is 30 minutes. The gate gives itself 20 of them and then fails, so that it tears the stack down itself. A hook killed by its timeout would leave containers behind.

## What the hooks do not do

The guard catches honest mistakes early. It is a convenience, and the gate is the authority: the gate re-derives scope from Git and runs the configuration frozen at activation, whatever happened during the session.

- The shell reader recognizes common write forms, not every program that can write a file. A script or interpreter can still modify a protected path; the gate's scope check then fails, because it compares protected files with the base tree by content.
- The gate reads Git with replacement refs disabled and rejects index flags, nested repositories, and changed `.gitignore` files. It does not defend against a process that edits `.git` directly: the activation record, `.git/info/exclude`, and the attempt count are files your user account can write. The guard denies the agent those writes; nothing stronger does.
- Files that Git ignores are outside the candidate, but a Docker build copies whatever `.dockerignore` allows. Keep `.dockerignore` at least as strict as `.gitignore`, or an ignored file can change what is tested.
- Hooks run with your OS permissions, and so do the commands in `harness.json` and your Compose files. Review them as you would any script.
- Use Claude Code's permission rules as the enforcement boundary. `/harness:setup` proposes deny rules for secrets and acceptance inputs.
- In permission-bypass modes an agent can read any file you can. Tests a builder must not be able to read need a separate verifier identity or machine, which this version does not provide; the `holdouts` step reports `NOT_RUN`.
- Worktrees separate edits. They share Git metadata and host permissions.
- The candidate digest covers tracked and untracked, non-ignored files. Ignored files, base images, and external services can change independently.
- Run evidence in the Git common directory can contain application logs. Review it before sharing.
