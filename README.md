# Local Share

Small project to share data (text, photos, videos, files) between devices connected on the same internet/WiFi network.

## Features

- Text chat between connected devices
- Send photos, videos, and other files
- Drag & drop files (desktop)
- Temporary nickname — pick your own or continue as guest (`user-1`, `user-2`, ...)
- Nickname restored automatically after reconnect
- QR code to quickly open on phone
- No database, no upload to disk — files are relayed directly
- Responsive (mobile + desktop)

## Requirements

- Node.js 18+
- All devices must be on the same WiFi / LAN

## Usage

```bash
pnpm install
pnpm start
```

Or with npm:

```bash
npm install
npm start
```

The terminal will print a URL like:

```
http://192.168.1.10:3000
```

Open it from any device on the same network. On desktop, click **QR** to show a QR code and scan it from your phone.

## How it works

- `server.js` runs an HTTP + WebSocket server. It relays messages and file chunks between connected clients.
- `public/index.html` is the client. It connects via WebSocket, handles the UI, and chunks files into 16 KB pieces for reliable transfer.
- Nothing is stored — when the server stops or a client disconnects, all data is gone.

## Notes

- Nicknames are stored in `sessionStorage` — closing the tab clears them.
- Guest names (`user-N`) are reused if you reconnect before closing the tab.
- Files are not saved to disk. If a device is not online when a file is sent, it won't receive it.
- Best used on trusted networks. There is no authentication.

## License

MIT
