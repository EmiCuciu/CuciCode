---
description: Bring an existing project into the CuciCode workflow, one stage at a time (map, baseline, scope, audit, backlog). Use on a codebase that was not started with CuciCode.
argument-hint: "<stage: map | baseline | scope | audit | backlog>"
disable-model-invocation: true
---

Run the onboarding stage: $ARGUMENTS

Each stage writes one file in `Plans/onboarding/` and stops for my approval. Read the files of earlier stages before starting.

- **map** — Use the `cucicode:explorer` agent (several in parallel for a large codebase) to describe the project: purpose, stack, folder structure, entry points, how to run, test and build it. Write `Plans/onboarding/map.md`.
- **baseline** — Run the test and build commands found in the map. Record exactly what passes and fails today in `Plans/onboarding/baseline.md`. Do not fix anything.
- **scope** — Ask me which parts of the project agents may work on and which are off limits. Write `Plans/onboarding/scope.md`, including suggested protected paths.
- **audit** — Within the agreed scope, list problems worth fixing (failing checks, missing tests, risky code, outdated dependencies), each with `path:line` and evidence. Write `Plans/onboarding/audit.md`. Do not fix anything.
- **backlog** — Turn the audit items I approve into stories using the `cucicode:story-writer` agent.

If the stage name is missing or unknown, list the stages and say which ones already have a file.
