# Specification: Express GET API (No DB, No Validations)

## Quick Assessment
**Classification:** Quick
**Rationale:** One-sentence description — a bare Express server with a GET endpoint. ≤3 files. Standard scaffold with zero design decisions.

## Problem Statement
Create a minimal Express.js application that exposes a GET API endpoint for testing purposes. No database, no input validation — just a route that returns a response. The app serves as a smoke-test or sandbox to verify Express routing works and to iterate on API design before adding persistence or validation layers.

## Users and Personas
- **Primary:** Developer testing the Express framework / building a proof-of-concept API.
- **No end users.** This is a development sandbox.

## Scope
### In Scope
- Working Express server on a configurable port
- At least one `GET` route returning a JSON response with HTTP 200
- `package.json` with `express` as the sole runtime dependency
- `npm start` script that boots the server

### Out of Scope
- Database / persistence (no PostgreSQL, MongoDB, SQLite, etc.)
- Input validation (no Joi, Zod, express-validator)
- Authentication / authorization
- POST, PUT, PATCH, DELETE routes
- Middleware beyond what Express ships with
- Tests, linting, TypeScript, Docker
- Environment variable loading (dotenv)

## Acceptance Criteria
1. **WHEN** `npm start` is run **THEN** the server SHALL bind to a port and log the listening address.
2. **WHEN** a client sends `GET /api/hello` (or equivalent) **THEN** the server SHALL respond with JSON `{ "message": "..." }` and status 200.
3. **WHEN** a client sends `GET` to an undefined route **THEN** the server SHALL respond with 404 (Express default is acceptable).

## Files to Create
| File | Purpose |
|------|---------|
| `package.json` | Project metadata, `express` dependency, `"start"` script |
| `server.js` | Express app: port binding, route registration, listen |

## Functional Requirements
- **EXP-01**: Project SHALL have a `package.json` with `express` as a runtime dependency.
- **EXP-02**: `npm start` SHALL invoke `node server.js` and start the server without errors.
- **EXP-03**: `GET /api/hello` SHALL return `{ "message": "Hello, world!" }` (or developer-chosen message) with `Content-Type: application/json` and status 200.
- **EXP-04**: Server SHALL listen on `process.env.PORT` with fallback to `3000`.

## Non-Functional Requirements
- **Performance:** Not applicable (development sandbox).
- **Observability:** Not applicable.

## Open Questions
- None. This is a minimal scaffold. All decisions (port, route path, response shape) have sensible defaults.
