---
description: Define or verify an API contract (routes, request and response shapes, errors, auth) so backend and frontend agree. Use before building an endpoint or when a client and server drift apart.
argument-hint: "<feature or endpoint; add 'verify' to compare an existing contract with the code>"
disable-model-invocation: true
---

API contract: $ARGUMENTS

Write or update `Plans/api/<feature>.md`, using the existing OpenAPI file if the project has one.

For each endpoint:

- Method and path, auth requirement, and the roles allowed.
- Request: path and query parameters, body fields with type, required or optional, limits.
- Response per status code, with an example body. Include the error shape used across the project.
- Idempotency, pagination, and rate limits where they apply.
- Validation rules and the status code each failure returns.

Reuse naming, casing and error shape already in the project; read two or three existing endpoints first.

With `verify`: compare the contract with the code and the client calls. List mismatches as `path:line` with the contract value and the actual value. Do not fix them; propose which side should change.

Do not write implementation code. Stories for the backend and frontend should cite this file.
