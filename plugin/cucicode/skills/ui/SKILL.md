---
description: Design a user interface change before building it, covering screens, states, components and accessibility. Use before a story that touches UI.
argument-hint: <screen or feature>
disable-model-invocation: true
---

UI design: $ARGUMENTS

Read the existing components, styles and design tokens first, and reuse them. Write `Plans/ui/<feature>.md` with:

- **Screens and flow** — what the user sees and does, step by step.
- **Components** — which exist and are reused, which are new, and their props.
- **States** — empty, loading, error, success, disabled, long text, narrow width.
- **Copy** — labels, messages, error text, in the project's language and tone.
- **Accessibility** — keyboard order, focus handling, labels, contrast, screen reader text.
- **Data** — which API calls feed each screen (cite the contract in `Plans/api/` if present).
- **Acceptance criteria** — observable checks a reviewer can verify.

Follow `rules/frontend.md`. Do not write implementation code.
