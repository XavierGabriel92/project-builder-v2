# Quality Standards — testing-feature

**Service:** `testing-feature`
**Last updated:** 2026-06-18

## Linting

- **Tool:** ESLint v10.5.0 with `@eslint/js` (flat config)
- **Config:** `eslint.config.js` — Node.js globals enabled
- **Script:** `npm run lint`
- **Policy:** Zero lint errors required before merge

## Testing

- **Manual verification:** `curl http://localhost:3000/` confirms the `GET /` handler
- **Automated tests:** Not yet configured (out of scope for initial feature)

## Code Style

- **Module system:** CJS (`require`) — the `package.json` does not declare `"type": "module"`
- **Error handling:** Consider adding `app.listen` error callback for production use
- **Graceful shutdown:** Consider adding SIGTERM/SIGINT handlers for production use

## Acceptance Criteria

All features must pass acceptance criteria verified via manual integration
testing before being considered complete. See individual feature summaries
for specific criteria.
