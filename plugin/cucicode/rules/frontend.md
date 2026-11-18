# Frontend rules

- Reuse existing components, styles and design tokens before adding new ones.
- Every screen handles loading, empty, error and success states.
- Accessibility: semantic elements, labels on every input, visible focus, full keyboard use, sufficient contrast, alt text.
- Forms validate on the client for feedback and trust only the server for correctness; show server errors next to the field.
- Never store secrets or tokens in code; keep auth tokens out of `localStorage` when an HTTP-only cookie is possible.
- Do not render untrusted HTML; escape or sanitize it.
- Keep components small and typed; lift state only as far as needed; no data fetching inside presentational components.
- Responsive from phone width up; no horizontal page scroll.
- Call the API only as the contract in `Plans/api/` defines; share types with the backend where the stack allows.
- Tests: component tests for behavior, and at least one end-to-end path for each critical flow.
