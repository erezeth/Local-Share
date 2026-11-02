# Security Policy

## Supported versions

Security fixes target the current `main`/`beta` release line. Older forks may not receive fixes.

## Reporting a vulnerability

Please do not publish an exploitable issue in the public tracker. Send a private report to the repository owner with:

- affected version/commit,
- reproduction steps,
- impact and required attacker position (same LAN, browser tab, reverse proxy, etc.),
- any suggested fix.

You should receive an acknowledgement within a few days. Please allow time for a fix and coordinated disclosure.

## Threat model

Local Share is designed for a trusted LAN. It provides:

- token authentication for WebSocket and `/qr`,
- same-origin checks for browser WebSocket upgrades,
- strict message validation and resource limits,
- XSS-safe rendering in the bundled client.

It does **not** provide:

- end-to-end encryption (the server can read chat/files),
- per-user cryptographic identity,
- persistence or audit history,
- protection against a malicious server operator,
- protection from network observers when TLS is not enabled.

For untrusted networks, terminate TLS at a trusted reverse proxy or use a VPN/Tailscale-style tunnel, set a stable `ACCESS_TOKEN`, and keep `AUTH_DISABLED=false`.

## Built-in controls

| Control                         | Default                 |
| ------------------------------- | ----------------------- |
| WebSocket auth timeout          | 10 s                    |
| Auth attempts per IP            | 30/min                  |
| Chat rate                       | 12 burst, 2/s sustained |
| File relay rate                 | 32 MB/s, 4 MB burst     |
| WebSocket max payload           | 64 KiB                  |
| Max file size                   | 100 MB                  |
| Max active transfers per client | 3                       |
| Max clients                     | 100                     |
| QR requests per IP              | 30/min                  |
| Idle transfer timeout           | 60 s                    |

All values are configurable; see `.env.example` and the README.
