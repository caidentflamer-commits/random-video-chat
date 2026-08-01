/*
 * Olumie — signaling + matchmaking server (rooms, mesh, moderation)
 * -------------------------------------------------------------------------
 * Jobs:
 *   1. Serve the frontend (public/ folder) over HTTP.
 *   2. Matchmake and relay WebRTC signaling for both solo 1-on-1 chat AND
 *      "Party Mode" (two friends team up, then meet strangers together).
 *   3. Basic moderation: a user can REPORT someone, which bans them by IP.
 *
 * Model:
 *   - Every socket has a stable `peerId`.
 *   - A PARTY is a durable group of 1 (solo) or 2 (friends joined by code).
 *   - A SESSION is two parties matched together (2–4 people total). Everyone
 *     in a session is a full WebRTC mesh (a direct peer connection per pair).
 *   - Matchmaking pairs PARTIES: any two fit (1+1, 2+1, 2+2 all ≤ 4).
 *   - "Next" dissolves the session; each party returns to matchmaking intact.
 *   - Solo-vs-solo is just a 2-person mesh — identical to the old 1-on-1 flow.
 *
 * Bans are kept in memory (reset on restart) — fine for a small setup.
 * STUN-only, WebRTC mesh, no media server (SFU). Max 4 per room by design.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- ICE / TURN config (from env, never committed) ------------------------
// Direct P2P (STUN) works for most 1-on-1s; a TURN relay is needed when a peer
// sits behind a strict/symmetric NAT (common on mobile data & some Wi-Fi) and
// matters more for 3–4-person mesh rooms. Configure via Render env vars — see
// TURN.md. Two supported schemes:
//   • HMAC (coturn `use-auth-secret` / TURN REST): TURN_URLS + TURN_SECRET
//   • Static credentials (some managed providers): TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL
// With nothing set, we fall back to STUN-only (today's behavior).
function buildIceServers() {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const urls = (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (urls.length && process.env.TURN_SECRET) {
    const ttl = parseInt(process.env.TURN_TTL || '43200', 10); // seconds (default 12h)
    const username = `${Math.floor(Date.now() / 1000) + ttl}:olumie`;
    const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
    servers.push({ urls, username, credential });
  } else if (urls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    servers.push({ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  return servers;
}

// ---- 1. Serve the frontend files -----------------------------------------

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};

// Strip links from chat (basic anti-scam). Bypassable client-side, so enforce here too.
const LINK_RE = /(https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+\.(?:com|net|org|io|co|gg|xyz|link|ru|tv|me|app|live|info|biz)\S*)/gi;

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  // ICE/TURN config for the client (fresh HMAC credentials each request).
  if (urlPath === '/ice') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ iceServers: buildIceServers() }));
  }

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

let searching = [];                 // parties currently in matchmaking (not in a session)
const partiesByCode = new Map();    // join code -> party awaiting a second member
const bannedIps = new Set();
let nextId = 1;

const FALLBACK_MS = 6000;           // pair long-waiting parties regardless of interests
const REPORT_LAST_GRACE_MS = 30000; // how long a just-left stranger can still be reported
const RECENT_COOLDOWN_MS = 8000;    // don't instantly re-match the party you just skipped

// ---- small utilities ------------------------------------------------------

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function send(socket, obj) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(obj));
}
function normalizeInterests(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((s) => String(s).trim().toLowerCase()).filter(Boolean))].slice(0, 10);
}
function intersect(a, b) {
  if (!a || !b) return [];
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}
// A region/language preference: empty, 'any' or 'anywhere' all mean "no filter".
function normPref(v) { return typeof v === 'string' ? v.trim().toLowerCase() : ''; }
function isAnyPref(v) { return !v || v === 'any' || v === 'anywhere'; }
// Two parties may match only if language AND region are compatible.
function compatible(a, b) {
  const langOK = isAnyPref(a.language) || isAnyPref(b.language) || a.language === b.language;
  const regionOK = isAnyPref(a.country) || isAnyPref(b.country) || a.country === b.country;
  return langOK && regionOK;
}
function normalizePrefs(msg) {
  return { interests: normalizeInterests(msg.interests), country: normPref(msg.country), language: normPref(msg.language) };
}

// ---- parties, rooms & mesh -----------------------------------------------

function makeCode() {
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]; }
  while (partiesByCode.has(c));
  return c;
}
function newParty(socket) {
  const p = { id: nextId++, code: null, members: [socket], prefs: { interests: [], country: '', language: '' }, session: null, recentlyLeft: {} };
  socket.party = p;
  return p;
}
// Was `a` just in a session with party `b`? (Used to skip instant re-matches.)
function recentlyPaired(a, b) {
  const t = a.recentlyLeft && a.recentlyLeft[b.id];
  return !!t && (Date.now() - t) < RECENT_COOLDOWN_MS;
}
// Everyone this socket is (or should be) mesh-connected to right now.
function roomMembers(socket) {
  const p = socket.party;
  if (!p) return [socket];
  if (p.session) { const all = []; p.session.parties.forEach((pt) => pt.members.forEach((m) => all.push(m))); return all; }
  return p.members;
}
// Deterministic initiator per pair (smaller peerId offers) — avoids WebRTC glare.
function connectPair(a, b, friend) {
  send(a, { type: 'peer-join', peerId: b.peerId, initiator: a.peerId < b.peerId, friend: !!friend });
  send(b, { type: 'peer-join', peerId: a.peerId, initiator: b.peerId < a.peerId, friend: !!friend });
}
function leavePair(a, b) {
  send(a, { type: 'peer-leave', peerId: b.peerId });
  send(b, { type: 'peer-leave', peerId: a.peerId });
}

// ---- matchmaking ----------------------------------------------------------

function enqueue(party) {
  if (party.session || party.members.length === 0) return;
  searching = searching.filter((p) => p !== party);

  // Best compatible shared-interest match among waiting parties.
  let bestIdx = -1, bestScore = 0;
  for (let i = 0; i < searching.length; i++) {
    const q = searching[i];
    if (!compatible(party.prefs, q.prefs) || recentlyPaired(party, q)) continue;
    const score = intersect(party.prefs.interests, q.prefs.interests).length;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  // No shared interest: if this party listed none, take any compatible party.
  if (bestIdx === -1 && party.prefs.interests.length === 0) {
    bestIdx = searching.findIndex((q) => compatible(party.prefs, q.prefs) && !recentlyPaired(party, q));
  }
  if (bestIdx !== -1) {
    const partner = searching.splice(bestIdx, 1)[0];
    return match(party, partner);
  }

  party.waitingSince = Date.now();
  searching.push(party);
  party.members.forEach((m) => send(m, { type: 'waiting' }));
}

// Pair up parties that have waited past FALLBACK_MS (still respecting filters).
setInterval(() => {
  const now = Date.now();
  const stale = searching.filter((p) => now - (p.waitingSince || now) >= FALLBACK_MS);
  for (let i = 0; i < stale.length; i++) {
    const a = stale[i];
    if (!searching.includes(a)) continue;
    for (let j = i + 1; j < stale.length; j++) {
      const b = stale[j];
      if (!searching.includes(b) || !compatible(a.prefs, b.prefs) || recentlyPaired(a, b)) continue;
      searching = searching.filter((p) => p !== a && p !== b);
      match(a, b);
      break;
    }
  }
}, 2000);

function match(pA, pB) {
  const session = { parties: [pA, pB] };
  pA.session = session; pB.session = session;
  searching = searching.filter((p) => p !== pA && p !== pB);

  // Mesh: connect every cross-party pair (within-party pairs already connected).
  pA.members.forEach((a) => pB.members.forEach((b) => connectPair(a, b, false)));

  const shared = intersect(pA.prefs.interests, pB.prefs.interests);
  [...pA.members, ...pB.members].forEach((m) => send(m, { type: 'matched', shared, size: pA.members.length + pB.members.length }));
  console.log(`Session: party#${pA.id}(${pA.members.length}) + party#${pB.id}(${pB.members.length})`);
}

// Dissolve a session. `reenqueue` is the list of parties that keep searching.
function dissolveSession(session, reenqueue) {
  const [pA, pB] = session.parties;
  const now = Date.now();
  // Drop the cross-party mesh connections and remember opponents for "Report last".
  pA.members.forEach((a) => pB.members.forEach((b) => {
    leavePair(a, b);
    a.lastOpponents = (a.lastOpponents || []).concat({ ip: b.ip, at: now });
    b.lastOpponents = (b.lastOpponents || []).concat({ ip: a.ip, at: now });
  }));
  pA.session = null; pB.session = null;
  pA.recentlyLeft[pB.id] = now; pB.recentlyLeft[pA.id] = now;   // no instant re-match
  reenqueue.forEach((p) => { if (p && p.members.length) enqueue(p); });
}

// ---- moderation / bans ----------------------------------------------------

function banSocket(socket) {
  bannedIps.add(socket.ip);
  console.log(`Banned IP ${socket.ip} (${socket.peerId})`);
  send(socket, { type: 'banned' });
  setTimeout(() => { if (socket.readyState === socket.OPEN) socket.close(); }, 300);
}

// ---- a socket leaves (disconnect or ban) ----------------------------------

function leaveAll(socket) {
  const p = socket.party;
  socket.party = null;
  if (!p) return;

  // Tell everyone currently connected to this socket that it's gone.
  const mates = roomMembers(socket).filter((m) => m !== socket);
  mates.forEach((m) => send(m, { type: 'peer-leave', peerId: socket.peerId }));

  p.members = p.members.filter((m) => m !== socket);

  if (p.members.length === 0) {
    // Party emptied out.
    searching = searching.filter((x) => x !== p);
    if (p.code) partiesByCode.delete(p.code);
    if (p.session) {
      const other = p.session.parties.find((x) => x !== p);
      p.session = null;
      if (other) { other.session = null; if (other.members.length) enqueue(other); }  // partner-left → re-search
    }
  }
  // If the party still has a member and was in a session, the session continues
  // for the remaining member(s); nothing else to do.
}

// ---- connection handler ---------------------------------------------------

wss.on('connection', (socket, req) => {
  socket.id = nextId++;
  socket.peerId = 'u' + socket.id;
  socket.ip = getClientIp(req);
  socket.party = null;
  socket.lastOpponents = [];

  if (bannedIps.has(socket.ip)) {
    send(socket, { type: 'banned' });
    return socket.close();
  }
  console.log(`Connected ${socket.peerId} (${socket.ip})`);

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      // ---- Party setup ----
      case 'create-party': {
        if (socket.party && (socket.party.members.length > 1 || socket.party.session)) break;
        const p = (socket.party && !socket.party.session) ? socket.party : newParty(socket);
        if (p.code) partiesByCode.delete(p.code);
        p.code = makeCode();
        partiesByCode.set(p.code, p);
        send(socket, { type: 'party-created', code: p.code });
        break;
      }
      case 'join-party': {
        const code = String(msg.code || '').trim().toUpperCase();
        const p = partiesByCode.get(code);
        if (!p || p.members.length !== 1 || p.session) {
          return send(socket, { type: 'party-error', reason: "That code isn't valid or the party is full." });
        }
        if (socket.party && socket.party !== p) leaveAll(socket);   // drop any solo party first
        p.members.push(socket);
        socket.party = p;
        partiesByCode.delete(code);
        connectPair(p.members[0], p.members[1], true);
        p.members.forEach((m) => send(m, { type: 'party-joined', size: 2 }));
        break;
      }
      case 'leave-party': {
        const p = socket.party;
        if (p && p.members.length > 1 && !p.session) {
          leaveAll(socket);        // remove me from the shared party (tells my friend)
          newParty(socket);        // and give me a fresh solo party
        }
        break;
      }

      // ---- Enter matchmaking ----
      case 'ready':          // solo
      case 'party-ready': {  // as a formed party
        let p = socket.party || newParty(socket);
        if (p.session) break;                     // already matched — ignore
        p.prefs = normalizePrefs(msg);
        enqueue(p);
        break;
      }

      // ---- In a room ----
      case 'signal': {
        const to = roomMembers(socket).find((m) => m.peerId === msg.to);
        if (to) send(to, { type: 'signal', from: socket.peerId, data: msg.data });
        break;
      }
      case 'chat': {
        if (typeof msg.text === 'string' && msg.text.trim()) {
          const clean = msg.text.slice(0, 500).replace(LINK_RE, '[link removed]');
          roomMembers(socket).forEach((m) => { if (m !== socket) send(m, { type: 'chat', from: socket.peerId, text: clean }); });
        }
        break;
      }
      case 'next': {
        const p = socket.party;
        if (!p) break;
        if (msg.interests !== undefined) p.prefs = normalizePrefs(msg);
        if (p.session) dissolveSession(p.session, p.session.parties.slice());   // both parties re-search
        else if (!searching.includes(p)) enqueue(p);
        break;
      }
      case 'stop': {
        const p = socket.party;
        if (!p) break;
        if (p.session) {
          const other = p.session.parties.find((x) => x !== p);
          dissolveSession(p.session, other ? [other] : []);   // this party goes idle; they re-search
        } else {
          searching = searching.filter((x) => x !== p);        // leave the queue
        }
        p.members.forEach((m) => send(m, { type: 'stopped' }));  // both friends return together
        break;
      }

      // ---- Moderation ----
      case 'report': {
        const target = roomMembers(socket).find((m) => m.peerId === msg.to && m !== socket);
        if (!target) break;
        console.log(`Report ${socket.peerId} -> ${target.peerId} reason=${msg.reason || 'n/a'} note=${(msg.note || '').slice(0, 120)}`);
        const p = socket.party;
        banSocket(target);
        send(socket, { type: 'report-ack' });
        if (p && p.session) dissolveSession(p.session, p.session.parties.filter((x) => x.members.length));
        break;
      }
      case 'report-last': {
        const cutoff = Date.now() - REPORT_LAST_GRACE_MS;
        const recent = (socket.lastOpponents || []).filter((o) => o.at >= cutoff);
        if (recent.length) {
          recent.forEach((o) => bannedIps.add(o.ip));
          console.log(`Report-last ${socket.peerId} banned ${recent.length} ip(s) reason=${msg.reason || 'n/a'}`);
          // Disconnect any of those still online.
          wss.clients.forEach((c) => { if (recent.some((o) => o.ip === c.ip) && c.readyState === c.OPEN) banSocket(c); });
          send(socket, { type: 'report-ack', last: true });
          socket.lastOpponents = [];
        }
        break;
      }
    }
  });

  socket.on('close', () => {
    console.log(`Disconnected ${socket.peerId}`);
    leaveAll(socket);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Olumie is running!`);
  console.log(`  Open this in your browser:  http://localhost:${PORT}\n`);
  console.log(`  Tip: open it in TWO tabs (or two windows) to match with yourself.\n`);
});
