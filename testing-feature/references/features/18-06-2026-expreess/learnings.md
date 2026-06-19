# Learnings — Express API

**Feature:** `18-06-2026-expreess`
**Date:** 2026-06-18

## What went well

- **Zero friction:** The feature was completely isolated — no integration with
  the main TypeScript project, no shared dependencies, no build tooling
  conflicts. CJS `require()` worked without any configuration.
- **Implement-then-lint:** The lint phase auto-installed ESLint (`eslint`
  ^10.5.0 with `@eslint/js`) and configured it for Node.js globals. The
  13-line server passed with zero lint errors.
- **Fast verification:** `curl http://localhost:3000/` confirmed both
  acceptance criteria in one command.

## What could be improved

- **Error handling:** The server crashes with an unhandled `EADDRINUSE` if
  port 3000 is occupied. A `process.on('uncaughtException', ...)` handler or
  `app.listen` error callback would make it more robust for development use.
- **Graceful shutdown:** No SIGTERM/SIGINT handler. Adding one would prevent
  dangling processes when `npm start` is killed.
- **Port range:** Using a well-known port (3000) without checking availability
  can cause collisions in multi-service development environments.

## Decisions

| Decision | Rationale |
|----------|-----------|
| CJS over ESM | Simpler for a single-file server; no `"type": "module"` needed |
| Express 4.x over 5.x | Express 5 was still in development; 4.x is stable and battle-tested |
| No TypeScript | Spec explicitly excluded it; keeps the feature dead-simple |
| No tests | Spec explicitly excluded them; acceptance was verified via curl |

## Dependencies added

- `express` ^4.21.0 → resolved to 4.22.2
- `eslint` ^10.5.0 (dev, added during lint phase)
- `@eslint/js` (dev, added during lint phase)
