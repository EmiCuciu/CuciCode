---
description: Analyze the project's architecture, stack, risks and quality gaps and write a report. Use before planning work on an unfamiliar or changing codebase.
argument-hint: "[area or folder, default: whole project]"
disable-model-invocation: true
---

Analyze: $ARGUMENTS

Use the `cucicode:explorer` agent (several in parallel for a large codebase). Write `Plans/analysis.md` with:

- **Stack** — languages, frameworks, package managers, how to run, test, build and lint.
- **Structure** — folders, layers, entry points, where each kind of code lives.
- **Conventions** — naming, error handling, configuration, logging, as actually used.
- **API surface** — routes, events or exported modules, with `path:line`.
- **Quality gaps** — missing tests, untested critical paths, duplicated code, dead code, large files, outdated or unused dependencies.
- **Risks** — security, data loss, concurrency, secrets, missing validation.
- **Infrastructure** — Docker, CI, environment files; whether they match the code.

Back every claim with `path:line` and a command output where possible. Rank gaps and risks by impact. Do not change code. End by suggesting which items are worth turning into a plan.
