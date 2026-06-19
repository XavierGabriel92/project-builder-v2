# Maintenance Notes — Express API

**Feature:** `18-06-2026-expreess`
**Last updated:** 2026-06-18

## How to start

```bash
cd testing-feature
npm start
```

Server listens on `http://localhost:3000` (override with `PORT` env var).

## How to test manually

```bash
curl http://localhost:3000/
# Expected: {"message":"Hello, world!"}
```

## How to lint

```bash
cd testing-feature
npm run lint
```

Uses ESLint v10.5.0 with `@eslint/js` — config in `eslint.config.js`.

## Dependencies

| Package | Version | Notes |
|---------|---------|-------|
| `express` | ^4.21.0 | Keep on 4.x until Express 5 is stable |
| `eslint` | ^10.5.0 | Dev only — configured for Node.js globals |
| `@eslint/js` | latest | ESLint flat config support |

## Files to know about

| File | What it does |
|------|-------------|
| `index.js` | The entire server — 13 lines |
| `package.json` | Dependencies and scripts |
| `eslint.config.js` | Lint configuration |

## Common issues

- **EADDRINUSE:** Port 3000 already in use. Kill the existing process or set
  `PORT=3001 npm start`.
- **MODULE_NOT_FOUND:** Run `npm install` if `node_modules/` is missing.

## Isolation note

This feature is fully isolated from the main `project-builder-v2` TypeScript
project. It has its own `package.json`, its own `node_modules/`, and no import
or reference to anything in the parent project. Changes to the main project
will not affect this service and vice versa.
