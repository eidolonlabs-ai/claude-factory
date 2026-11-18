## Claude Factory

This project uses Claude Factory. `factory.json` names the Docker Compose stack, the end-to-end test service, and the paths a task may never edit.

Work happens under an approved task with a pinned base commit, allowed paths, and observable acceptance criteria. Draft one with `/factory:intake`; the owner activates it. Edit only the task's allowed paths. Tests, Compose files, and `factory.json` are acceptance inputs: if a task seems to need a change there, stop and ask the owner.

A change is done when the gate passes on the exact candidate. The gate boots the real stack, waits for health, runs the test service, and removes what it created. A check that did not run is not a pass. Report which checks ran and their results; the owner decides when to ship.
