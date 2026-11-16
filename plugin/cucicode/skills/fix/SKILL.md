---
description: Fix a story whose checks failed or whose review requested changes. Use when a story came back from checks or review.
argument-hint: <story id, then the failing output or the review findings>
disable-model-invocation: true
---

Story and what needs fixing: $ARGUMENTS

Fix exactly the problems listed: failing checks or blocking review findings. Stay inside the story's `owned_files`. Do not weaken or delete tests to make them pass, and do not refactor code that is not part of the problem.

Run the checks again. Commit with a message starting with the story id and the word "fix". Report what you changed and the result of each check.
