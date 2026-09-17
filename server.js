const express = require("express");
const http = require("http");
const os = require("os");
const path = require("path");
const { WebSocketServer } = require("ws");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 32 * 1024 * 1024 });

/* helpers */
function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

const sanitizeName = (s) =>
  String(s || "").replace(/[<>&"'`\\]/g, "").trim().slice(0, 20);

/* state */
const clients = new Map();
let nextAnon = 1;

function nextGuestName() {
  const used = new Set();
  for (const c of clients.values()) {
    const m = /^user-(\d+)$/.exec(c.name);
    if (m) used.add(parseInt(m[1], 10));
  }
  let n = 1;
  while (used.has(n)) n++;
  return "user-" + n;
}

function broadcast(obj, except) {
  const s = JSON.stringify(obj);
  for (const [client] of clients) {
    if (client !== except && client.readyState === 1) client.send(s);
  }
}

function broadcastUsers() {
  const users = [];
  for (const c of clients.values()) users.push({ name: c.name });
  broadcast({ type: "users", users });
}

/* ws */
wss.on("connection", (ws) => {
  clients.set(ws, { name: "anon-" + nextAnon++ });
  broadcastUsers();

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      for (const [client] of clients) {
        if (client !== ws && client.readyState === 1) {
          client.send(data, { binary: true });
        }
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const me = clients.get(ws);
    if (!me) return;

    switch (msg.type) {
      case "ping":
        return;

      case "guest": {
        me.name = nextGuestName();
        try { ws.send(JSON.stringify({ type: "guest-name", name: me.name })); } catch {}
        broadcastUsers();
        return;
      }

      case "hello":
      case "rename": {
        const name = sanitizeName(msg.name);
        if (name) me.name = name;
        broadcastUsers();
        return;
      }

      case "chat": {
        const text = String(msg.text || "").slice(0, 2000);
        if (!text) return;
        broadcast({ type: "chat", from: me.name, text, ts: Date.now() }, ws);
        return;
      }

      case "file-start":
      case "file-end":
        broadcast({ ...msg, from: me.name }, ws);
        return;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    broadcastUsers();
  });
});

/* routes */
app.get("/qr", async (req, res) => {
  const url = `http://${getLanIp()}:${PORT}`;
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 300 });
  res.json({ url, qr });
});

server.listen(PORT, () => {
  console.log(`\n  Server jalan di  http://${getLanIp()}:${PORT}\n`);
});