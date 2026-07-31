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

// Clean up a user's interest list: lowercase, trimmed, de-duplicated, capped.
function normalizeInterests(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(
    list.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
  )].slice(0, 10);
}

function intersect(a, b) {
  if (!a || !b) return [];
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}

function pair(a, b) {
  partners.set(a, b);
  partners.set(b, a);
  const shared = intersect(a.interests, b.interests);
  send(a, { type: 'matched', initiator: true, shared });
  send(b, { type: 'matched', initiator: false, shared });
  console.log(`Paired #${a.id} <-> #${b.id}${shared.length ? ' (shared: ' + shared.join(', ') + ')' : ''}`);
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

// How long an interest-seeker waits for a shared-interest partner before we
// fall back to matching them with anyone (so nobody is ever stuck).
const FALLBACK_MS = 6000;

function enqueue(socket) {
  waiting = waiting.filter((s) => s !== socket);

  // 1) Best shared-interest match among people already waiting.
  let bestIdx = -1, bestScore = 0;   // start at 0: only a real overlap counts
  for (let i = 0; i < waiting.length; i++) {
    const s = waiting[i];
    if (s.readyState !== s.OPEN) continue;
    const score = intersect(socket.interests, s.interests).length;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  if (bestIdx !== -1) {
    const partner = waiting.splice(bestIdx, 1)[0];
    return pair(socket, partner);
  }

  // 2) No shared interest found. If THIS user listed no interests, they don't
  //    care who they meet — match them with whoever has waited longest.
  if (socket.interests.length === 0) {
    const idx = waiting.findIndex((s) => s.readyState === s.OPEN);
    if (idx !== -1) {
      const partner = waiting.splice(idx, 1)[0];
      return pair(socket, partner);
    }
  }

  // 3) Otherwise wait a bit — a shared-interest partner may arrive. The
  //    fallback sweeper below pairs anyone who has waited past FALLBACK_MS.
  socket.waitingSince = Date.now();
  waiting.push(socket);
  send(socket, { type: 'waiting' });
}

// Fallback matcher: pair up users who've been waiting too long, regardless of
// interests, so an interest-seeker never waits forever.
setInterval(() => {
  const now = Date.now();
  const stale = waiting.filter((s) => s.readyState === s.OPEN && now - (s.waitingSince || now) >= FALLBACK_MS);
  while (stale.length >= 2) {
    const a = stale.shift();
    const b = stale.shift();
    waiting = waiting.filter((s) => s !== a && s !== b);
    pair(a, b);
  }
}, 2000);

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
  socket.interests = [];

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
        socket.interests = normalizeInterests(msg.interests);
        unpair(socket, true);
        enqueue(socket);
        break;

      case 'signal': {
        const partner = partners.get(socket);
        if (partner) send(partner, { type: 'signal', data: msg.data });
        break;
      }

      // Relay a text chat message to the current partner (length-capped).
      case 'chat': {
        const partner = partners.get(socket);
        if (partner && typeof msg.text === 'string' && msg.text.trim()) {
          send(partner, { type: 'chat', text: msg.text.slice(0, 500) });
        }
        break;
      }

      case 'next':
        if (msg.interests !== undefined) socket.interests = normalizeInterests(msg.interests);
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
