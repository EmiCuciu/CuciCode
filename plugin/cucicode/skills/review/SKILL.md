---
description: Review the diff of one story with the logic, security, UI and code-rules reviewers. Use after a story's checks pass and before it is merged.
argument-hint: <story id, e.g. S-001>
disable-model-invocation: true
---

Review story $ARGUMENTS.

Work out the diff to review: the commits on the current branch that are not on the default branch (`git diff <default-branch>...HEAD`). Review only that diff.

Run these agents in parallel, giving each the story file path and the diff range:

- `cucicode:reviewer-logic`
- `cucicode:reviewer-security`
- `cucicode:reviewer-code-rules`
- `cucicode:reviewer-ui` — only if the diff touches user interface files

Then give me one combined report: blocking findings first (with reviewer, `path:line`, problem and fix), then notes. Drop duplicates. Do not fix anything yourself.

Set `review: approved` in the story's frontmatter when no reviewer reported a blocking finding, otherwise `review: changes_requested`. End with the single line `RESULT: approved` or `RESULT: changes_requested`.
