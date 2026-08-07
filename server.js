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

// Hosts we'll send a user back to after the Stripe portal. Anything else falls
// back to the canonical domain, so the return URL can't be steered by a caller.
const RETURN_HOSTS = new Set(['olumie.chat', 'www.olumie.chat', 'random-video-chat-azkk.onrender.com']);

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

// ---- Supabase (durable bans + reports; accounts come next) ----------------
// Inert unless SUPABASE_URL + SUPABASE_SERVICE_KEY are set. In-memory paths
// remain as a fast cache/fallback, so nothing breaks when it's not configured.
// Accept both the new (SUPABASE_SECRET_KEY) and classic (SUPABASE_SERVICE_KEY) names.
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
let supa = null;
if (process.env.SUPABASE_URL && SUPABASE_SECRET) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supa = createClient(process.env.SUPABASE_URL, SUPABASE_SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
    console.log('Supabase connected — durable bans + reports enabled.');
  } catch (e) { console.warn('Supabase init failed (staying in-memory):', e.message); }
}

// ---- Stripe (Premium subscriptions) --------------------------------------
// Inert unless STRIPE_SECRET_KEY is set. The webhook flips profiles.is_premium.
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
// THROWS on a genuine write failure so the webhook answers 500 and Stripe shows
// a failed delivery (and retries). A green 200 that silently wrote nothing is
// the worst possible outcome to debug.
async function handleStripeEvent(event) {
  if (!supa) return;
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const userId = s.client_reference_id;   // = the Supabase user id we appended to the link
    if (!userId) { console.warn('stripe: checkout completed with no client_reference_id — cannot map it to a user'); return; }
    // Upsert, not update: with no profiles row, .update() matches zero rows and
    // still reports success, leaving is_premium false with no error anywhere.
    const { error } = await supa.from('profiles')
      .upsert({ id: userId, is_premium: true, stripe_customer_id: s.customer || null }, { onConflict: 'id' });
    if (error) throw new Error(`profiles upsert failed for user ${userId}: ${error.message}`);
    // Without a customer id the cancel path below can never find this row again.
    if (!s.customer) console.warn(`stripe: no customer on session for ${userId} — cancel will not be able to match them`);
    console.log(`Premium ON: ${userId} (customer ${s.customer || 'none'})`);
  } else if (event.type === 'customer.subscription.deleted' ||
    (event.type === 'customer.subscription.updated' && ['canceled', 'unpaid', 'incomplete_expired'].includes(event.data.object.status))) {
    const customer = event.data.object.customer;
    if (!customer) return;
    const { data, error } = await supa.from('profiles')
      .update({ is_premium: false }).eq('stripe_customer_id', customer).select('id');
    if (error) throw new Error(`premium-off update failed for customer ${customer}: ${error.message}`);
    if (!data || !data.length) console.warn(`stripe: no profile matched customer ${customer} — premium NOT cleared`);
    else console.log(`Premium OFF for customer ${customer} → user ${data.map((r) => r.id).join(',')}`);
  }
}
async function dbInsertBan(ip, reason) {
  if (!supa || !ip) return;
  try { await supa.from('bans').insert({ ip, reason: reason || null }); } catch (e) { console.warn('db ban insert:', e.message); }
}
async function dbIsBanned(ip) {
  if (!supa || !ip) return false;
  try {
    const { data } = await supa.from('bans').select('id').eq('ip', ip)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`).limit(1);
    return !!(data && data.length);
  } catch { return false; }
}
async function dbInsertReport(rec) {
  if (!supa) return;
  try {
    await supa.from('reports').insert({
      kind: rec.kind, reporter: rec.reporter, reporter_ip: rec.reporterIp,
      target: rec.target, target_ip: rec.targetIp, reason: rec.reason, note: rec.note, action: rec.action,
    });
  } catch (e) { console.warn('db report insert:', e.message); }
}

// Verify a Supabase session token (from a signed-in browser) and attach the
// user to the socket. Anonymous users simply never send this. Best-effort:
// any failure just leaves the socket anonymous.
async function handleAuth(socket, token) {
  if (!supa) return;
  // A null/empty token means "signed out" — drop the account from this socket so
  // premium gating stops right away instead of lingering until they reconnect.
  if (typeof token !== 'string' || !token) {
    if (socket.userId) console.log(`Signed out ${socket.peerId} (${socket.userId})`);
    socket.userId = null;
    socket.isPremium = false;
    send(socket, { type: 'account', email: null, premium: false });
    return;
  }
  try {
    const { data, error } = await supa.auth.getUser(token);
    if (error || !data || !data.user) return;
    socket.userId = data.user.id;
    // Guarantee the profiles row exists. The signup trigger normally creates it,
    // but a user who signed up before the trigger existed has none — and then
    // both the premium read below and the Stripe webhook silently see nothing.
    try { await supa.from('profiles').upsert({ id: socket.userId }, { onConflict: 'id', ignoreDuplicates: true }); } catch (e) { console.warn('profile ensure:', e.message); }
    let premium = false;
    try {
      const { data: prof } = await supa.from('profiles').select('is_premium').eq('id', socket.userId).maybeSingle();
      premium = !!(prof && prof.is_premium);
    } catch {}
    socket.isPremium = premium;   // gates gender-preference filtering server-side
    send(socket, { type: 'account', email: data.user.email || null, premium });
  } catch {}
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

  // Stripe webhook (POST) — raw body required for signature verification.
  if (req.method === 'POST' && urlPath === '/stripe/webhook') {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) { res.writeHead(503); return res.end('stripe not configured'); }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      // Two distinct failures, two distinct codes: a bad signature is permanent
      // (400, Stripe won't retry), a failed DB write is worth retrying (500).
      let event;
      try {
        event = stripe.webhooks.constructEvent(Buffer.concat(chunks), req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
      } catch (e) {
        console.warn('stripe webhook signature error:', e.message);
        res.writeHead(400); return res.end('bad signature');
      }
      try {
        await handleStripeEvent(event);
        res.writeHead(200); res.end('ok');
      } catch (e) {
        console.error(`stripe handler error (${event.type}):`, e.message);
        res.writeHead(500); res.end('handler error');
      }
    });
    return;
  }

  // Stripe customer portal — lets a subscriber cancel or update their card
  // themselves. Without it the only exits are emailing us or filing a dispute,
  // and dispute rate is what gets a high-risk merchant terminated.
  // Auth is the caller's Supabase token; we look the customer up server-side so
  // a caller can never name someone else's Stripe customer.
  if (req.method === 'POST' && urlPath === '/portal') {
    const fail = (code, error) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error })); };
    if (!stripe || !supa) return fail(503, 'not configured');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
        const { data, error } = await supa.auth.getUser(String(body.token || ''));
        if (error || !data || !data.user) return fail(401, 'not signed in');
        const { data: prof } = await supa.from('profiles').select('stripe_customer_id').eq('id', data.user.id).maybeSingle();
        if (!prof || !prof.stripe_customer_id) return fail(404, 'no subscription found');
        // Return URL comes from the request host, never from the caller — an
        // attacker-supplied one would turn this into an open redirect.
        const host = String(req.headers.host || '').toLowerCase();
        const returnUrl = RETURN_HOSTS.has(host) ? `https://${host}/` : 'https://olumie.chat/';
        const session = await stripe.billingPortal.sessions.create({ customer: prof.stripe_customer_id, return_url: returnUrl });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: session.url }));
      } catch (e) {
        // Surface Stripe's own error code so a failure is identifiable without
        // digging through host logs. The code is a short enum (resource_missing,
        // invalid_request_error, …) — no customer data in it.
        const code = e && (e.code || e.type) ? String(e.code || e.type) : 'unknown';
        console.error(`portal: [${code}] ${e && e.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'could not open the subscription page', code }));
      }
    });
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';

  // ICE/TURN config for the client (fresh HMAC credentials each request).
  if (urlPath === '/ice') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ iceServers: buildIceServers() }));
  }

  // Public client config (Supabase URL + anon key). Empty until env is set.
  if (urlPath === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      supabaseUrl: process.env.SUPABASE_URL || '',
      supabaseAnonKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '',
      supabaseConnected: !!supa,   // server successfully created the admin client (secret key OK)
      premiumUrl: process.env.STRIPE_PAYMENT_LINK || '',   // Premium subscription checkout link
    }));
  }

  // Moderation report log (JSON). Gated by ?key=<ADMIN_KEY>; disabled if unset.
  if (urlPath === '/admin/reports') {
    const key = new URLSearchParams((req.url.split('?')[1] || '')).get('key');
    if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) { res.writeHead(403); return res.end('Forbidden'); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ count: recentReports.length, reports: recentReports.slice().reverse() }, null, 2));
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
  // Gender is mutual: each side's preference (Premium only) must be met by the other's gender.
  const genderOK =
    (isAnyGenderPref(a.genderPref) || a.genderPref === b.gender) &&
    (isAnyGenderPref(b.genderPref) || b.genderPref === a.gender);
  return langOK && regionOK && genderOK;
}
// Gender: self-declared 'm' | 'f' | 'o' (or '' = unspecified).
function normGender(v) { const g = String(v || '').toLowerCase(); return ['m', 'f', 'o'].includes(g) ? g : ''; }
// Gender preference (Premium only): 'any' | 'm' | 'f'.
function normGenderPref(v) { const g = String(v || '').toLowerCase(); return ['m', 'f'].includes(g) ? g : 'any'; }
function isAnyGenderPref(v) { return !v || v === 'any'; }

function normalizePrefs(msg, premium) {
  return {
    interests: normalizeInterests(msg.interests),
    country: normPref(msg.country),
    language: normPref(msg.language),
    gender: normGender(msg.gender),
    // Only Premium accounts may filter by gender; everyone else is forced to "any".
    genderPref: premium ? normGenderPref(msg.genderPref) : 'any',
  };
}

// ---- report audit trail ---------------------------------------------------
// Three layers: structured server logs (Render captures them), an in-memory
// buffer viewable at /admin/reports (gated by ADMIN_KEY), and an optional
// webhook push (REPORT_WEBHOOK_URL, Discord-compatible) for a durable feed.
const recentReports = [];
const MAX_REPORTS = 500;
function logReport(rec) {
  rec.ts = new Date().toISOString();
  console.log('REPORT ' + JSON.stringify(rec));
  recentReports.push(rec);
  if (recentReports.length > MAX_REPORTS) recentReports.shift();
  dbInsertReport(rec);   // durable copy (no-op if Supabase unset)
  const hook = process.env.REPORT_WEBHOOK_URL;
  if (hook && typeof fetch === 'function') {
    const line = `🚩 **${rec.kind}** · reason: ${rec.reason || 'n/a'}${rec.note ? ` · note: ${rec.note}` : ''} · reporter ${rec.reporter} → ${rec.target || rec.targetIp || 'n/a'} · ${rec.action}`;
    try { fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: line.slice(0, 1900) }) }).catch(() => {}); } catch {}
  }
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
  // Durable ban check (survives restarts). Fast in-memory check above covers the
  // common case; this catches bans persisted before this process started.
  dbIsBanned(socket.ip).then((banned) => {
    if (banned && socket.readyState === socket.OPEN) { bannedIps.add(socket.ip); send(socket, { type: 'banned' }); socket.close(); }
  });
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

      // ---- Account ----
      case 'auth':
        handleAuth(socket, msg.token);
        break;

      // ---- Enter matchmaking ----
      case 'ready':          // solo
      case 'party-ready': {  // as a formed party
        let p = socket.party || newParty(socket);
        if (p.session) break;                     // already matched — ignore
        p.prefs = normalizePrefs(msg, !!socket.isPremium);
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
        if (msg.interests !== undefined) p.prefs = normalizePrefs(msg, !!socket.isPremium);
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
        logReport({
          kind: String(msg.reason || '').startsWith('auto:') ? 'auto-moderation' : 'user-report',
          reporter: socket.peerId, reporterIp: socket.ip, target: target.peerId, targetIp: target.ip,
          reason: String(msg.reason || '').slice(0, 80), note: String(msg.note || '').slice(0, 200), action: 'banned',
        });
        const p = socket.party;
        dbInsertBan(target.ip, String(msg.reason || '').slice(0, 80));   // durable ban
        banSocket(target);
        send(socket, { type: 'report-ack' });
        if (p && p.session) dissolveSession(p.session, p.session.parties.filter((x) => x.members.length));
        break;
      }
      case 'report-last': {
        const cutoff = Date.now() - REPORT_LAST_GRACE_MS;
        const recent = (socket.lastOpponents || []).filter((o) => o.at >= cutoff);
        if (recent.length) {
          recent.forEach((o) => { bannedIps.add(o.ip); dbInsertBan(o.ip, 'report-last'); });
          logReport({
            kind: 'report-last', reporter: socket.peerId, reporterIp: socket.ip, target: null,
            targetIp: recent.map((o) => o.ip).join(','), reason: String(msg.reason || '').slice(0, 80),
            note: String(msg.note || '').slice(0, 200), action: `banned ${recent.length} ip(s)`,
          });
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
