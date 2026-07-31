/*
 * Random Video Chat — signaling + matchmaking server
 * --------------------------------------------------
 * This single file does two jobs:
 *   1. Serves the frontend (the public/ folder) over plain HTTP.
 *   2. Runs a WebSocket server that pairs up waiting users and relays
 *      the WebRTC "handshake" messages between each matched pair.
 *
 * It never touches the actual video/audio — that flows directly between
 * the two browsers (peer-to-peer). The server only introduces them.
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
  // Only allow simple GETs for files inside public/.
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

// ---- 2. WebSocket signaling + matchmaking --------------------------------

const wss = new WebSocketServer({ server });

// Users who are online but not yet paired sit in this queue.
let waiting = [];
// Map of socket -> its current partner socket.
const partners = new Map();

let nextId = 1;

function pair(a, b) {
  partners.set(a, b);
  partners.set(b, a);
  // One side is the "initiator" — it will create the WebRTC offer.
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

// Add a socket to the waiting queue and try to match it immediately.
function enqueue(socket) {
  // Remove any stale copy of this socket first.
  waiting = waiting.filter((s) => s !== socket);

  // Find a waiting partner that is still connected and isn't this socket.
  const partnerIndex = waiting.findIndex((s) => s !== socket && s.readyState === s.OPEN);
  if (partnerIndex !== -1) {
    const partner = waiting.splice(partnerIndex, 1)[0];
    pair(socket, partner);
  } else {
    waiting.push(socket);
    send(socket, { type: 'waiting' });
  }
}

function send(socket, obj) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(obj));
  }
}

wss.on('connection', (socket) => {
  socket.id = nextId++;
  console.log(`Connected #${socket.id}`);

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      // Client is ready to be matched with a new stranger.
      case 'ready':
        unpair(socket, true);
        enqueue(socket);
        break;

      // Relay a WebRTC offer/answer/ICE candidate to the current partner.
      case 'signal': {
        const partner = partners.get(socket);
        if (partner) send(partner, { type: 'signal', data: msg.data });
        break;
      }

      // Client hit "Next": drop the current partner and re-queue.
      case 'next':
        unpair(socket, true);
        enqueue(socket);
        break;
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
