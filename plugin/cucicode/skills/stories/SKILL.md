---
description: Turn an approved plan into user stories in Stories/, each with acceptance criteria and the files it owns. Use after a plan in Plans/ is approved.
argument-hint: <feature name, matching Plans/<feature>.md>
disable-model-invocation: true
---

Write the stories for the plan `Plans/$ARGUMENTS.md`.

Use the `cucicode:story-writer` agent. It writes one file per story in `Stories/` with frontmatter (id, feature, title, status, acceptance_criteria, owned_files, depends_on, worker, branch, review).

When it finishes, show me a table of the stories (id, title, owned files, depends on) and point out any two stories whose owned files overlap. Do not start building: the stories need my approval first.
