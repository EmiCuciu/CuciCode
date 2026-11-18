---
description: Report a write that a hook or permission blocked, once and completely, instead of retrying. Use when an edit is denied by a protected-path hook, a code-rules hook or a permission prompt.
argument-hint: <story id>
disable-model-invocation: true
---

A write was blocked for story $ARGUMENTS. Do not retry it, and do not write the same path through Bash or PowerShell: the block is a decision by the user, not an obstacle.

1. Collect every file you still need to write that is blocked, not just the first one.
2. For each, give the path, the hook's reason, and the complete file content, ready to paste.
3. Name the smallest unblock, in this order of preference:
   - set `git.protectedPathsMode` to `"ask"` in `.claude/cucicode/settings.json`, so each protected write becomes a permission prompt the user can approve;
   - remove the specific pattern from `git.protectedPaths`;
   - create the files by hand.
4. Finish any work that does not depend on the blocked files. Do not run checks that cannot pass without them, and say which you skipped.
5. Do not set the story status to `review`. End with `RESULT: blocked`.

If the same blocker was already reported in this session and nothing has changed, say that in one line and stop.
