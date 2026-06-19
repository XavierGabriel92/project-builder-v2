# Specification: Express App Scaffold in testing-feature

## Quick Assessment
**Classification:** Quick
**Rationale:** One-sentence description, ≤3 files, standard Express scaffold with zero design ambiguity.

## Problem Statement
Create a minimal Express.js application in `testing-feature/` as a sandbox/demo to explore the Express framework. The directory exists but is empty. The parent project (`project-builder-v2`) is a TypeScript flow orchestration engine — this Express app is a separate, standalone project for experimentation.

## Scope
### In Scope
- A working Express server that starts and responds to HTTP requests
- At least one route (e.g., `GET /` returning a status or hello-world response)
- A `package.json` with Express as a dependency
- A start script (`npm start` or `node server.js`)

### Out of Scope
- TypeScript (keep it plain JS for quick experimentation unless user requests otherwise)
- Database integration
- Authentication / authorization
- Tests
- Production hardening
- Docker / deployment configuration

## Functional Requirements
- **EXP-01**: Project SHALL have a valid `package.json` with `express` as a dependency.
- **EXP-02**: Project SHALL have a server entry point that creates an Express app, binds to a port, and logs the listening address.
- **EXP-03**: Server SHALL respond to `GET /` with a meaningful response (JSON or plain text) and status 200.
- **EXP-04**: `npm start` SHALL start the server without errors.

## Files to Create
| File | Purpose |
|------|---------|
| `testing-feature/package.json` | Project metadata + dependencies + start script |
| `testing-feature/server.js` | Express app entry point with at least one route |

## Non-Requirements
- No TypeScript compilation step needed (plain `.js`)
- No linting, formatting, or test tooling required
- No connection to the parent `project-builder-v2` codebase

## Open Questions
- None. This is a minimal scaffold. The user can iterate from here.
