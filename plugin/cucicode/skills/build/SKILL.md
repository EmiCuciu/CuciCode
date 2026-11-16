---
description: Implement one story from Stories/ and run the project's checks. Use after stories are approved.
argument-hint: <story id, e.g. S-001>
disable-model-invocation: true
---

Implement story $ARGUMENTS.

Find its file in `Stories/` (the name starts with the id). If you are already working inside a git worktree created for this story, implement it here yourself following the worker instructions below. Otherwise use the `cucicode:worker` agent, which works in its own worktree.

Worker instructions:

1. Read the story and the plan it refers to in `Plans/`.
2. Set `status: in_progress` in the story's frontmatter.
3. Change only files matched by the story's `owned_files`. If another file is needed, stop and report it.
4. Run the checks named in the plan. Fix what fails without weakening tests.
5. Verify each acceptance criterion.
6. Commit with a message starting with the story id, then set `status: review` and commit that.

Report what changed, the result of each check with the command used, and how each acceptance criterion was verified. Do not merge anything.
