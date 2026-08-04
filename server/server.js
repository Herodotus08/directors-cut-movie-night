/**
 * Director's Cut — signalling + haptic bridge server.
 *
 * Two transports over one port, both driven by the same RoomHub:
 *   ws://host:8080/signal   raw WebSocket — used by the extension (no client
 *                           library to bundle, so no CSP or MV3 friction)
 *   ws://host:8080/bridge   raw WebSocket — phones / wearables, jolt sink
 *   socket.io (default path) same protocol for anything already speaking it
 *
 * It only brokers the handshake. Once the peers have exchanged SDP the media and
 * all interactive traffic is peer-to-peer and this process goes quiet.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { RoomHub, SIG } = require('./rooms');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const HEARTBEAT_MS = 25000;
// A public rendezvous is a free open socket to anyone who finds the URL. Rooms
// are already capped individually; this is the whole-process ceiling that keeps
// one bored stranger from exhausting a small free-tier instance's file handles.
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS) || 200;

let liveClients = 0;

const log = (...args) => console.log(new Date().toISOString(), ...args);
const hub = new RoomHub({ log: (m) => log('[room]', m) });

// ---------------------------------------------------------------------------
// HTTP: health check + the reference phone client
// ---------------------------------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, ...hub.stats(), clients: liveClients, max: MAX_CLIENTS, uptime: process.uptime(),
    }));
    return;
  }

  // Static, with the path resolved and then re-checked so `..` cannot escape.
  const rel = url.pathname === '/' ? 'mobile.html' : url.pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
});

// ---------------------------------------------------------------------------
// raw WebSocket transport
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (socket, request, role) => {
  // The path already decided the role for /bridge, so it is not negotiable.
  const client = hub.attach((msg) => socket.send(JSON.stringify(msg)),
    { role, fixedRole: role === 'phone' });
  liveClients++;
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', (raw) => {
    if (raw.length > 64 * 1024) return; // SDP is a few KB; anything larger is junk
    let msg = null;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    hub.handle(client, msg);
  });

  // `close` always follows `error`, so the counter is decremented exactly once.
  socket.on('close', () => { liveClients--; hub.leave(client); });
  socket.on('error', () => hub.leave(client));
  log(`[ws] ${role} connected as ${client.id} from ${request.socket.remoteAddress}`);
});

// One WS server, routed by path, so /signal and /bridge share the port.
server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, 'http://localhost');
  const role = pathname === '/bridge' ? 'phone' : pathname === '/signal' ? 'viewer' : null;
  if (!role) {
    socket.destroy();
    return;
  }
  // Refuse over the ceiling *before* the handshake, so the client gets a real
  // status line instead of a socket that opens and then vanishes.
  if (liveClients >= MAX_CLIENTS) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request, role));
});

/** Drop half-open sockets: a laptop lid closing does not send a FIN. */
setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_MS).unref();

// ---------------------------------------------------------------------------
// socket.io transport (optional — same protocol, different envelope)
// ---------------------------------------------------------------------------

try {
  const { Server } = require('socket.io');
  const io = new Server(server, { cors: { origin: '*' } });
  io.on('connection', (socket) => {
    if (liveClients >= MAX_CLIENTS) {
      socket.disconnect(true);
      return;
    }
    const role = socket.handshake.query?.role === 'phone' ? 'phone' : 'viewer';
    const client = hub.attach((msg) => socket.emit('dc', msg), { role });
    liveClients++;
    socket.on('dc', (msg) => hub.handle(client, msg));
    // Also accept one-event-per-type clients, which is more idiomatic socket.io.
    for (const t of [SIG.JOIN, SIG.SIGNAL, SIG.JOLT, SIG.LEAVE, SIG.PING]) {
      socket.on(t, (payload) => hub.handle(client, { ...payload, t }));
    }
    socket.on('disconnect', () => { liveClients--; hub.leave(client); });
  });
  log('[io] socket.io transport enabled');
} catch {
  log('[io] socket.io not installed — raw WebSocket only');
}

server.listen(PORT, HOST, () => {
  log(`Director's Cut signalling on ws://${HOST}:${PORT}/signal`);
  log(`Haptic bridge on ws://${HOST}:${PORT}/bridge — phone client at http://${HOST}:${PORT}/`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('shutting down');
    for (const socket of wss.clients) socket.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
