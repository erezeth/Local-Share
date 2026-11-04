<p align="center">
  <img src="assets/banner.png" alt="Local Share — share text and files between devices on the same LAN" width="100%" />
</p>

# Local Share

Share text, photos, videos, and files between devices on the same LAN over a WebSocket connection. No database, no cloud, no file storage: content is relayed through the server and kept in memory.

## Features

- Token-protected WebSocket and QR endpoint
- Text chat, including **targeted chat** to one online device
- Send photos, videos, and other files
- **Targeted file transfers** with per-recipient delivery; broadcast is still available
- Transfer progress and connection status in the UI
- Fresh green-themed interface with **dark and light modes** that default to the system preference and remember your choice
- Lightweight front-end: one HTML file plus one script, system fonts, inline SVG icons, and an optimized PNG logo — no frameworks, no build step, no external requests
- Initial-letter avatars, a CSS-only empty state, and `aria-live` chat announcements
- Drag & drop files on desktop
- Temporary nickname — pick your own or continue as guest (`user-1`, `user-2`, ...)
- Nickname restored after reconnect for the same tab
- QR code to quickly open on a phone
- Responsive layout, no database, no upload to disk
- Idle-client heartbeat, strict message validation, rate limits, and graceful shutdown

## Architecture

```text
public/index.html + public/app.js
            │  HTTP: static app, /healthz, authenticated /qr
            ▼
server.js ──► src/create-server.js
            ├── src/routes.js       Express, CSP/security headers, QR
            ├── src/websocket.js    auth, validation, rate limits, file relay
            ├── src/state.js        in-memory client registry / targeted send
            ├── src/transfers.js    per-file owner, recipients, byte accounting
            ├── src/protocol.js     strict WebSocket message validation
            ├── src/security.js     sanitization, token compare, rate limiters
            └── src/config.js       environment configuration
```

`server.js` is intentionally small: it starts the app, prints the join URL/token, and handles `SIGINT`/`SIGTERM`. All relay traffic stays in memory.

### UI assets

- [`assets/banner.png`](assets/banner.png) — README banner
- [`assets/icon.png`](assets/icon.png) — source artwork for the app logo and favicon; a 128 px optimized copy is served from [`public/icon.png`](public/icon.png) (the server only exposes the `public/` directory)

### Data flow

1. The browser loads the static client. If the server requires authentication and there is no token in `sessionStorage`, the client asks for one.
2. The client connects to `ws://` or `wss://` and sends an `auth` message first.
3. The server validates the token, replies with `auth-ok`, and the client identifies itself with `hello` or `guest`.
4. The server broadcasts the named-user list. Chats and files are delivered to the selected peer, or to every named peer when "Semua" is selected.
5. A file transfer starts with `file-start`, is followed by binary chunks, and finishes with `file-end`. The server tracks the owner, recipients, and received byte count so a client cannot inject chunks into another user's transfer.

## Requirements

- Node.js **18.17+**
- All devices on the same WiFi / LAN, or a reachable reverse proxy

## Quick start

```bash
pnpm install
pnpm start
```

Or with npm:

```bash
npm install
npm start
```

The terminal prints a URL that already contains the access token, for example:

```text
http://192.168.1.10:3000/?token=...
Access token: ...
```

Open that URL, or scan the QR from the app. The client moves the token into `sessionStorage` and removes it from the address bar.

If `ACCESS_TOKEN` is not set, a random token is generated at startup. That means the token changes after every restart. Set a stable secret in production:

```bash
ACCESS_TOKEN="$(openssl rand -base64 32)" pnpm start
```

`.env.example` is a template only; this project reads process environment variables and does not auto-load `.env`. For a shell session:

```bash
set -a
. ./.env
set +a
pnpm start
```

## Configuration

Configuration is read from environment variables. See [`.env.example`](.env.example) for a copyable template. Never commit a real token.

| Variable                   | Default    | Purpose                                                                |
| -------------------------- | ---------- | ---------------------------------------------------------------------- |
| `PORT`                     | `3000`     | HTTP/HTTPS port                                                        |
| `HOST`                     | `0.0.0.0`  | Bind address                                                           |
| `ACCESS_TOKEN`             | generated  | Stable access token, at least 16 characters                            |
| `AUTH_DISABLED`            | `false`    | Explicitly disable authentication. **Unsafe on shared networks.**      |
| `PUBLIC_URL`               | auto       | Public base URL used by the QR route, e.g. `https://share.example.com` |
| `TLS_KEY` / `TLS_CERT`     | unset      | Paths to a PEM key/certificate. Both must be set to enable HTTPS/WSS.  |
| `ALLOWED_ORIGINS`          | same host  | Comma-separated extra WebSocket origins allowed by the origin check    |
| `TRUST_PROXY`              | `false`    | Trust `X-Forwarded-*` (only when behind a trusted reverse proxy)       |
| `MAX_CLIENTS`              | `100`      | Maximum concurrent WebSocket connections                               |
| `MAX_FILE_SIZE_MB`         | `100`      | Maximum declared file size                                             |
| `MAX_ACTIVE_TRANSFERS`     | `3`        | Concurrent outgoing transfers per client                               |
| `WS_MAX_PAYLOAD_BYTES`     | `65536`    | Maximum WebSocket message size (one 16 KiB chunk fits comfortably)     |
| `WS_MAX_BUFFERED_BYTES`    | `16777216` | Disconnect a recipient whose socket buffer grows beyond this           |
| `CHAT_RATE_CAPACITY`       | `12`       | Chat burst allowance                                                   |
| `CHAT_RATE_REFILL_PER_SEC` | `2`        | Sustained chat messages per second                                     |
| `FILE_RATE_MBPS`           | `32`       | Sustained file relay rate per client                                   |
| `FILE_RATE_BURST_MB`       | `4`        | File relay burst                                                       |
| `QR_RATE_LIMIT`            | `30`       | QR requests per IP per minute                                          |
| `AUTH_ATTEMPT_LIMIT`       | `30`       | WebSocket auth attempts per IP per minute                              |
| `TRANSFER_IDLE_TIMEOUT_MS` | `60000`    | Cancel a transfer that stops receiving chunks                          |
| `LOG_LEVEL`                | `info`     | `error`, `warn`, `info`, or `debug`                                    |

`ACCESS_TOKEN` must be at least 16 characters. Tokens are compared in constant time.

## HTTPS / WSS

Generate a self-signed certificate for a local-only deployment:

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem -out cert.pem -days 365 \
  -subj "/CN=local-share.local"
TLS_KEY=./key.pem TLS_CERT=./cert.pem pnpm start
```

Then open the `https://` URL printed by the server. Browsers will warn about an untrusted self-signed certificate until it is trusted on each device. For anything beyond a trusted LAN, put the app behind a TLS reverse proxy (Caddy, nginx, Tailscale, etc.) and set `PUBLIC_URL` and `ALLOWED_ORIGINS` accordingly.

Without TLS, traffic is plaintext on the LAN. The token protects access to the app, but it does not encrypt chat or file contents. Do not use this setup over an untrusted network without a TLS tunnel/VPN.

## WebSocket protocol

The WebSocket endpoint is the same host/port as the HTTP app. JSON control messages and binary file chunks are multiplexed on one connection.

### Client → server

| Type          | Fields                                              | Notes                                                             |
| ------------- | --------------------------------------------------- | ----------------------------------------------------------------- |
| `auth`        | `token`                                             | Must be the first message when auth is enabled                    |
| `hello`       | `name`, `clientId`                                  | Restores a remembered name; `name` may be `null`                  |
| `guest`       | `clientId`                                          | Assigns a `user-N` name                                           |
| `ping`        | —                                                   | Application-level keepalive                                       |
| `chat`        | `text`, optional `target`                           | `target` is a peer ID; omit to broadcast to all other named peers |
| `file-start`  | `fileId`, `name`, `mime`, `size`, optional `target` | Declares a transfer; server replies `file-start-ack`              |
| `file-end`    | `fileId`                                            | Completes a transfer after all chunks                             |
| `file-cancel` | `fileId`                                            | Cancels an in-flight transfer                                     |

Unknown fields are rejected. `fileId` must match `[A-Za-z0-9_-]{4,32}`.

### Server → client

| Type                                      | Fields                                                        | Notes                                                             |
| ----------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `auth-ok`                                 | `authRequired`, `limits`                                      | Authentication succeeded; limits include max file/chat/name sizes |
| `auth-error`                              | `message`                                                     | Auth failed; socket closes with 4401 (4429 if rate-limited)       |
| `welcome`                                 | `id`, `name`                                                  | Stable peer ID and assigned name                                  |
| `need-name`                               | —                                                             | The client must send `hello` or `guest`                           |
| `users`                                   | `users: [{ id, name }]`                                       | Named online users                                                |
| `chat`                                    | `from`, `fromId`, `text`, `ts`, optional `target`             | Relayed chat                                                      |
| `file-start-ack`                          | `fileId`, `recipients`                                        | The sender may start sending chunks when `recipients > 0`         |
| `file-start` / `file-end` / `file-cancel` | transfer metadata                                             | Sent only to the transfer recipients                              |
| `file-end-ack`                            | `fileId`                                                      | Confirms completion to the sender after all bytes are relayed     |
| `pong`                                    | `ts`                                                          | Response to application `ping`                                    |
| `error`                                   | `code`, `message`, optional `fileId`, optional `retryAfterMs` | Structured error                                                  |

### Binary chunk format

```text
byte 0          : fileId length (1–32)
bytes 1..N      : fileId (ASCII)
remaining bytes : chunk payload (the client uses 16 KiB chunks)
```

The server checks that the `fileId` belongs to the sender, that the declared size is not exceeded, and that the recipient list was captured at `file-start`. Chunks are never broadcast to unrelated clients.

### Close codes

| Code   | Meaning                                    |
| ------ | ------------------------------------------ |
| `4401` | Authentication required or invalid         |
| `4403` | Origin not allowed                         |
| `4429` | Authentication/message rate limit exceeded |
| `1008` | Too many invalid messages                  |
| `1009` | Message exceeds `WS_MAX_PAYLOAD_BYTES`     |
| `1013` | Server full or recipient too slow          |

## Security notes

- **Access control:** WebSocket authentication is required by default. `/qr` also requires the token. Static assets are public so the login screen can load.
- **XSS:** the server normalizes names/MIME types and bounds message sizes. The client inserts all dynamic values with `textContent`, never `innerHTML`, and the server sends a restrictive CSP. Chat text may contain `<`/`>` as plain text and is never interpreted as HTML.
- **Origin check:** browser WebSocket upgrades must be same-origin unless listed in `ALLOWED_ORIGINS` (or `PUBLIC_URL`). Non-browser clients without an `Origin` header are allowed.
- **Rate limits:** chat, file bytes/chunks, auth attempts, and QR requests are limited in memory per client/IP.
- **Resource limits:** message payloads, file sizes, active transfers, clients, and slow-socket buffers are bounded.
- **No secrets in code:** tokens come from `ACCESS_TOKEN` or a cryptographically random startup value.
- **Token in the join URL:** the URL/QR contains the token so scanning works. The client stores it in `sessionStorage` and replaces the address-bar entry, but the initial request may still appear in server/proxy logs. Treat logs as sensitive.
- **No persistence or E2E encryption:** the server sees all relayed content. If that is not acceptable, use a VPN/TLS tunnel or add end-to-end encryption (not implemented).

## Development

```bash
pnpm install
pnpm test          # unit + WebSocket integration tests
pnpm run lint
pnpm run format:check
pnpm run check     # lint + format check + tests
```

Tests use Node's built-in test runner and the existing `ws` dependency; no extra test framework is required.

### Manual smoke test

1. Start with a known token: `ACCESS_TOKEN=dev-token-0123456789 pnpm start`.
2. Open the printed URL in two browser tabs or two devices. Confirm the token disappears from the address bar and both clients show **Online**.
3. Send a broadcast chat, then select one recipient and send a targeted chat. Confirm only the selected client receives the targeted message.
4. Send a small file to a target and confirm the progress bar reaches 100% on both sides. Send another file with **Semua** selected.
5. Try a wrong token and confirm the auth overlay appears without a reconnect loop.
6. Stop the server with `Ctrl+C` or `SIGTERM`; confirm it logs the signal and exits within a few seconds.

## Limitations

- If a recipient is offline, a targeted message/file is rejected; broadcast transfers only go to clients online at `file-start`.
- Files are held in recipient memory until the transfer completes. A very large file can consume significant memory on every recipient.
- There is no message history, database, or file persistence.
- Nicknames are not identities; two clients may choose the same display name. Use the peer ID for targeting.
- The server assumes a single trusted LAN/host. It is not a hardened multi-tenant file server.
- Self-signed HTTPS requires trusting the certificate on each device.
- Proxy deployments need `PUBLIC_URL`, `ALLOWED_ORIGINS`, and often `TRUST_PROXY`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: see [SECURITY.md](SECURITY.md).

## License

MIT
