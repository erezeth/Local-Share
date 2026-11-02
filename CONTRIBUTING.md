# Contributing

Thanks for improving Local Share.

## Setup

```bash
pnpm install
pnpm test
pnpm run lint
pnpm run format:check
```

Node.js 18.17+ is required. The app uses only Node built-ins plus `express`, `ws`, and `qrcode` at runtime; keep new runtime dependencies small and justified.

## Workflow

1. Open an issue for non-trivial changes, especially protocol/security changes.
2. Create a focused branch.
3. Keep `server.js` as the entry point; put logic in `src/` modules.
4. Add tests for sanitization, validation, state, transfers, and WebSocket behavior when changing those areas.
5. Run `pnpm run check` before opening a pull request.

## Code style

- CommonJS modules in `src/` and `server.js`.
- Browser code lives in `public/app.js`; do not introduce `innerHTML` or string-built HTML. Render user-controlled values with `textContent` or DOM properties.
- Use the existing logger instead of raw `console.*` on the server.
- Do not add empty `catch` blocks. Log the error or return a deliberate, documented fallback.
- Keep changes consistent with the existing naming and module boundaries.

## Security-sensitive changes

Changes to authentication, origin checks, message validation, rate limits, file routing, or CSP need:

- a short threat-model note in the PR,
- tests for the failure path,
- a README update if configuration or protocol changes.

Do not commit real access tokens, certificates, or `.env` files. Use `ACCESS_TOKEN`/environment variables and document any new setting in `.env.example`.

## Commit and PR

Use clear commit messages. In the PR, describe:

- what changed and why,
- user-visible impact,
- security/reliability risks,
- test commands and results.

## Reporting security issues

Please follow [SECURITY.md](SECURITY.md) instead of opening a public issue for an exploitable vulnerability.
