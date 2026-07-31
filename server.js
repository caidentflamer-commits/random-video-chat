/*
 * Random Video Chat — signaling + matchmaking server (with basic moderation)
 * -------------------------------------------------------------------------
 * Jobs:
 *   1. Serve the frontend (public/ folder) over HTTP.
 *   2. Pair up waiting users and relay the WebRTC handshake between a pair.
 *   3. Basic moderation: let a user REPORT their partner, which bans that
 *      partner (by IP) and disconnects them so they can't reconnect.
 *
 * NOTE: bans are kept in memory, so they reset if the server restarts.
 * That's fine for a small/testing setup. A real launch would store bans in
 * a database — see README's "what's next".
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- 1. Serve the frontend files -----------------------------------------

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- 2. WebSocket signaling + matchmaking + moderation -------------------

const wss = new WebSocketServer({ server });

let waiting = [];                 // users online but not yet paired
const partners = new Map();       // socket -> partner socket
const bannedIps = new Set();      // IPs that reported partners banned
let nextId = 1;

// Best-effort client IP. On hosts like Render the real IP is in a header.
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function send(socket, obj) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
}

function pair(a, b) {
  partners.set(a, b);
  partners.set(b, a);
  send(a, { type: 'matched', initiator: true });
  send(b, { type: 'matched', initiator: false });
  console.log(`Paired #${a.id} <-> #${b.id}`);
}

function unpair(socket, notifyPartner) {
  const partner = partners.get(socket);
  if (partner) {
    partners.delete(partner);
    partners.delete(socket);
    if (notifyPartner && partner.readyState === partner.OPEN) {
      send(partner, { type: 'partner-left' });
    }
  }
}

function enqueue(socket) {
  waiting = waiting.filter((s) => s !== socket);
  const partnerIndex = waiting.findIndex((s) => s !== socket && s.readyState === s.OPEN);
  if (partnerIndex !== -1) {
    const partner = waiting.splice(partnerIndex, 1)[0];
    pair(socket, partner);
  } else {
    waiting.push(socket);
    send(socket, { type: 'waiting' });
  }
}

// Kick a socket off entirely (used when someone is banned).
function banSocket(socket) {
  bannedIps.add(socket.ip);
  console.log(`Banned IP ${socket.ip} (socket #${socket.id})`);
  send(socket, { type: 'banned' });
  waiting = waiting.filter((s) => s !== socket);
  unpair(socket, false);
  // Give the "banned" message a moment to send, then close the connection.
  setTimeout(() => {
    if (socket.readyState === socket.OPEN) socket.close();
  }, 300);
}

wss.on('connection', (socket, req) => {
  socket.id = nextId++;
  socket.ip = getClientIp(req);

  // Refuse banned users immediately.
  if (bannedIps.has(socket.ip)) {
    console.log(`Rejected banned IP ${socket.ip}`);
    send(socket, { type: 'banned' });
    return socket.close();
  }

  console.log(`Connected #${socket.id} (${socket.ip})`);

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'ready':
        unpair(socket, true);
        enqueue(socket);
        break;

      case 'signal': {
        const partner = partners.get(socket);
        if (partner) send(partner, { type: 'signal', data: msg.data });
        break;
      }

      case 'next':
        unpair(socket, true);
        enqueue(socket);
        break;

      // The current user reports their partner for bad behavior.
      case 'report': {
        const partner = partners.get(socket);
        if (partner) {
          banSocket(partner);          // ban + disconnect the reported person
          send(socket, { type: 'report-ack' });
          unpair(socket, false);
          enqueue(socket);             // put the reporter back in the queue
        }
        break;
      }
    }
  });

  socket.on('close', () => {
    console.log(`Disconnected #${socket.id}`);
    waiting = waiting.filter((s) => s !== socket);
    unpair(socket, true);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Random Video Chat is running!`);
  console.log(`  Open this in your browser:  http://localhost:${PORT}\n`);
  console.log(`  Tip: open it in TWO tabs (or two windows) to match with yourself.\n`);
});
