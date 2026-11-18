# Backend rules

- Layers: controller (transport only) → service (business rules) → repository (data access). No business logic in controllers, no HTTP types in services.
- Every endpoint has a documented contract (see `skills/api-contract`) and one error shape used everywhere.
- Authenticate and authorize on the server for every non-public route; deny by default.
- Use parameterized queries only; never build SQL or shell commands from user input.
- Hash passwords with a modern algorithm (argon2, bcrypt); never log passwords, tokens or personal data.
- Migrations are forward-only, reviewed, and run by a tool, never by hand against shared databases.
- Database access is behind a connection pool with configured limits; wrap multi-step writes in a transaction.
- Make external calls with timeouts and bounded retries; treat every response as untrusted.
- Pagination and limits on every list endpoint.
- Return the correct status code: 400 validation, 401 unauthenticated, 403 forbidden, 404 missing, 409 conflict, 5xx never with internals.
- Tests: unit tests for services, integration tests for repositories and endpoints against a real or in-memory database.
