---
description: Fix a story whose checks failed or whose review requested changes. Use when a story came back from checks or review.
argument-hint: <story id, then the failing output or the review findings>
disable-model-invocation: true
---

Story and what needs fixing: $ARGUMENTS

Fix the cause of exactly the problems listed: failing checks or blocking review findings. Do not weaken or delete tests to make them pass, and do not refactor code that is not part of the problem.

Scope: start from the story's `owned_files`, but the fix may need a file outside that list (a missing migration, config, fixture, manifest). Edit it when it is the root cause and say so in the report. Never use this to widen the work beyond the failure.

Find the cause in the repo first (missing file, wrong path, dependency), not in the test's expectation. If several files are missing, create all of them in one pass so the next check run can succeed.

Blocked writes: if a hook or permission denies an edit (for example a protected path), do not retry it and do not route around it with a shell write. Follow `cucicode:unblock`, and end with `RESULT: blocked`.

Run the checks again. Commit with a message starting with the story id and the word "fix". Report what you changed and the result of each check.
