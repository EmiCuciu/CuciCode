# General rules

- Follow the naming, structure and tooling already in the project; do not introduce a new convention.
- No secrets, tokens or environment-specific values in source. Read them from configuration; keep `.env*` out of git and commit an `.env.example` with placeholders.
- No hardcoded URLs, limits, ports or credentials; put them in configuration with a documented default.
- Handle errors explicitly: never swallow them, never expose internals to clients, log with context.
- Validate input at every boundary (HTTP, CLI, files, queues).
- Add or update tests with each behavior change. A bug fix starts with a test that fails.
- Never weaken, skip or delete a test to make it pass.
- Keep changes small and in scope; do not refactor unrelated code.
- Prefer small functions and clear names over comments; document public APIs and service responsibilities.
- Pin dependency versions through the lockfile; add a dependency only when it is used.
- Docker: pinned base image tags, non-root user, multi-stage builds, `.dockerignore`, no secrets in layers, a health check.
- Commits start with the story id and are focused on one change.
- When working in a project that has no git repo yet, initialize one (git init plus an initial commit) before writing code, so the branch and worktree rules can be followed.