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
 *   - A PARTY is a durable group of 1 (solo) or 2 — joined by code, or formed
 *     mid-call when two strangers both agree to stay together ("team up").
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
// TURN.md. Three supported schemes:
//   • Cloudflare Realtime: TURN_KEY_ID + TURN_KEY_API_TOKEN (minted, see below)
//   • HMAC (coturn `use-auth-secret` / TURN REST): TURN_URLS + TURN_SECRET
//   • Static credentials (some managed providers): TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL
// With nothing set, we fall back to STUN-only (today's behavior).

// Cloudflare issues SHORT-LIVED credentials from an API rather than a fixed
// username/password, so there is nothing static to paste into env vars —
// pasting a snapshot would work until it expired and then fail silently, which
// looks exactly like the NAT problem TURN is meant to solve.
//
// Minted server-side and cached, not fetched per request: the client already
// refetches /ice before every session, so a per-request call would put a
// Cloudflare round trip in front of every Start for no benefit. Re-minted at
// half the TTL so a session never begins with a credential about to expire.
const CF_TURN_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const TURN_TTL = Math.max(600, parseInt(process.env.TURN_TTL || '86400', 10));
let cfTurn = { servers: null, expires: 0, inflight: null };
async function cloudflareTurn() {
  const id = process.env.TURN_KEY_ID, token = process.env.TURN_KEY_API_TOKEN;
  if (!id || !token || typeof fetch !== 'function') return null;
  if (cfTurn.servers && Date.now() < cfTurn.expires) return cfTurn.servers;
  if (cfTurn.inflight) return cfTurn.inflight;      // one flight at a time, not one per caller
  cfTurn.inflight = (async () => {
    try {
      const r = await fetch(`${CF_TURN_API}/${encodeURIComponent(id)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TURN_TTL }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      // Their payload has been documented both as an object and as an array;
      // accept either rather than depending on which one you get.
      const list = Array.isArray(j.iceServers) ? j.iceServers : (j.iceServers ? [j.iceServers] : []);
      if (!list.length) throw new Error('no iceServers in response');
      cfTurn.servers = list;
      cfTurn.expires = Date.now() + (TURN_TTL / 2) * 1000;
      console.log(`TURN: Cloudflare credentials minted (ttl ${TURN_TTL}s)`);
      return list;
    } catch (e) {
      // Never fail /ice over this — STUN still works for most pairs, and a
      // relay that can't be reached is strictly worse than not offering one.
      // The failure is deliberately NOT cached: expires stays 0 so the next
      // /ice tries again. A blip shouldn't disable the relay for a whole TTL,
      // and the cost of a persistent misconfiguration is one failed request
      // per /ice (measured ~40ms), not a broken call.
      console.warn('TURN: Cloudflare credential fetch failed —', e.message);
      cfTurn.servers = null; cfTurn.expires = 0;
      return null;
    } finally { cfTurn.inflight = null; }
  })();
  return cfTurn.inflight;
}
// Async wrapper: same result as buildIceServers(), plus Cloudflare when configured.
async function buildIceServersAsync() {
  const servers = buildIceServers();
  const cf = await cloudflareTurn();
  if (cf) servers.push(...cf);
  return servers;
}
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
  '.webmanifest': 'application/manifest+json',
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
  // Page loads, not unique people — a reload counts again. Nothing is stored
  // per-visitor, so distinguishing them isn't possible here, by design.
  // Crawlers, link-preview fetchers and uptime monitors are skipped: once the
  // site is indexed they'd inflate visits and quietly crush startRate. A UA
  // check is heuristic, not perfect — a bot that lies looks like a person —
  // but it catches the honest majority. No UA at all also isn't a browser.
  if (urlPath === '/index.html') {
    const ua = String(req.headers['user-agent'] || '');
    if (ua && !BOT_RE.test(ua)) bump('visits');
  }

  // ICE/TURN config for the client (fresh HMAC credentials each request).
  if (urlPath === '/ice') {
    // Promise chain rather than an async handler, so the rest of the routing
    // above stays synchronous and untouched.
    return buildIceServersAsync().then((iceServers) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ iceServers }));
    });
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

  // Visitor beacon. POST rather than a query string so the id never lands in a
  // URL (and therefore never in access logs or a Referer header). Fires on page
  // load, which is why it lives here and not on the socket — the socket only
  // opens when someone presses Start, so it would miss everyone who bounced.
  if (urlPath === '/visit' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1000) req.destroy(); });
    req.on('end', () => {
      try { countVisitor(JSON.parse(body).vid); } catch {}
      res.writeHead(204); res.end();
    });
    return;
  }

  // Aggregate usage counters. Same ADMIN_KEY gate as /admin/reports, and the
  // same "inert until the env var is set" rule as everything else here.
  if (urlPath === '/admin/stats') {
    const q = new URLSearchParams((req.url.split('?')[1] || ''));
    if (!process.env.ADMIN_KEY || q.get('key') !== process.env.ADMIN_KEY) { res.writeHead(403); return res.end('Forbidden'); }
    const summary = statsSummary();
    // HTML by default (this gets opened in a browser); JSON on request so curl
    // and anything scripted keeps working exactly as before.
    if (q.get('format') === 'json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(summary, null, 2));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(statsPage(summary));
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

// ---- analytics ------------------------------------------------------------
// First-party and aggregate-only: plain counters, no cookies, no third party,
// no per-visitor records, nothing that identifies anyone. That's what keeps the
// privacy policy short and true, and it's why there's no consent banner.
//
// Most of it the server already knows (matches, skips, reports). The client
// only reports what happens inside the browser and nowhere else: whether the
// age gate was accepted, and — the number this exists for — whether media
// actually came up after a match. mediaFail vs mediaOk is the relay-failure
// rate, i.e. the evidence for or against needing TURN.
// Self-identifying non-humans: search crawlers, link-preview fetchers (a link
// pasted in Discord/WhatsApp fetches the page), uptime monitors, CLI tools.
const BOT_RE = /bot|crawl|spider|slurp|preview|monitor|pingdom|uptime|curl|wget|python-requests|headless|lighthouse|facebookexternalhit|whatsapp|telegram|discord|embedly|vkshare/i;
const STAT_EVENTS = ['gate', 'mediaOk', 'mediaFail', 'playBlocked'];
const stats = {
  since: new Date().toISOString(),
  visits: 0, people: 0, returning: 0, gate: 0, starts: 0, sessions: 0, teamups: 0,
  skips: 0, stops: 0, mediaOk: 0, mediaFail: 0, playBlocked: 0,
  reports: 0, bans: 0, peakOnline: 0,
};
// Unique browsers. The client sends a random id it keeps in localStorage; we
// hold the ids only to answer "have I seen this one before" and count. They're
// random strings tied to no account, no IP and no report — nothing here can be
// turned back into a person, and it's why "people" is really "browsers".
// Bounded so a flood of made-up ids can't grow this without limit; at the cap
// the set stops accepting new ids rather than evicting (eviction would silently
// re-count the evicted ones as new).
const seenVisitors = new Set();
const MAX_VISITORS = 50000;
function countVisitor(id) {
  if (typeof id !== 'string' || id.length < 8 || id.length > 64) return;
  if (seenVisitors.has(id)) { stats.returning++; return; }
  if (seenVisitors.size >= MAX_VISITORS) return;
  seenVisitors.add(id);
  stats.people++;
}
function bump(name, by) { if (Object.prototype.hasOwnProperty.call(stats, name)) stats[name] += (by || 1); }
// Percentages are the point — raw counters make you do arithmetic to answer
// "is this bad?", and nobody does it.
function statsSummary() {
  const media = stats.mediaOk + stats.mediaFail;
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
  return {
    ...stats,
    online: wss ? wss.clients.size : 0,
    // Against people, not page loads — reloads would flatter this otherwise.
    startRate: pct(stats.starts, stats.people),        // people → pressed Start
    returnRate: pct(stats.returning, stats.people + stats.returning),
    // Approximate: assumes both sides were solo, so it over-reports slightly
    // once Party Mode is in use (a session can hold 3–4 people, not 2).
    matchRate: pct(stats.sessions * 2, stats.starts),  // Start → actually matched
    mediaFailRate: pct(stats.mediaFail, media),        // ⚠ the TURN question
    // One merge per session, so this is NOT doubled the way matchRate is.
    teamUpRate: pct(stats.teamups, stats.sessions),    // matched → chose to stay together
  };
}
// A rollup into the logs every hour, so there's a history even though the
// counters live in memory and reset on deploy. Render keeps logs 7 days.
setInterval(() => { console.log('STATS ' + JSON.stringify(statsSummary())); }, 60 * 60 * 1000);

// ---- the numbers page -----------------------------------------------------
// Reuses clarity.css and the app's own dark tokens so it looks like the product
// rather than a debug dump. JSON is still there at ?format=json for curl.
function humanUptime(sinceIso) {
  const ms = Date.now() - new Date(sinceIso).getTime();
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `${d}d ${h % 24}h`;
  if (h) return `${h}h ${m % 60}m`;
  return `${m}m`;
}
// A rate is only meaningful once there's enough of it to mean anything; below
// that this says "too early" rather than dressing up noise as a finding.
function verdictForFailRate(rate, sample) {
  if (rate === null || sample < 10) return { tone: 'idle', line: 'Not enough connections yet to read this.' };
  if (rate === 0) return { tone: 'good', line: 'Every connection got through. No relay needed so far.' };
  if (rate < 5) return { tone: 'good', line: 'Normal. A few failures are expected without a relay.' };
  if (rate < 15) return { tone: 'warn', line: 'Worth watching. Around this level, TURN starts paying for itself.' };
  return { tone: 'bad', line: 'High. This is the case TURN exists for — see TURN.md.' };
}
function statsPage(s) {
  const n = (v) => (v === null || v === undefined ? '—' : v.toLocaleString('en-US'));
  const pctText = (v) => (v === null ? '—' : v + '%');
  const mediaTotal = s.mediaOk + s.mediaFail;
  const verdict = verdictForFailRate(s.mediaFailRate, mediaTotal);
  // Funnel bars are scaled to the widest step so the drop-off is visible at a
  // glance; without that, everything after step one is a sliver.
  const steps = [
    { label: 'Page loads', value: s.visits, note: 'reloads counted again' },
    { label: 'Browsers', value: s.people, note: 'not humans — see below' },
    { label: 'Pressed Start', value: s.starts, note: pctText(s.startRate) + ' of browsers' },
    { label: 'Got matched', value: s.sessions * 2, note: pctText(s.matchRate) + ' of starts' },
    { label: 'Stayed together', value: s.teamups, note: pctText(s.teamUpRate) + ' of matches' },
  ];
  const widest = Math.max(1, ...steps.map((x) => x.value));
  const bars = steps.map((x) => `
    <div class="step">
      <div class="step-head"><span class="step-label">${x.label}</span><span class="step-value">${n(x.value)}</span></div>
      <div class="track"><div class="fill" style="width:${Math.max(1.5, (x.value / widest) * 100)}%"></div></div>
      <div class="step-note">${x.note}</div>
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<title>Olumie · numbers</title>
<link rel="stylesheet" href="/clarity.css" />
<style>
  body { --primary:#6d63ff; --online:#3fcf6b; --danger:#fb5f7a; --warning:#f0a92e;
         margin:0; min-height:100vh; padding:28px var(--gutter) 56px; font-family:var(--font-display); }
  .wrap { max-width:960px; margin:0 auto; }
  header { display:flex; align-items:baseline; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:24px; }
  h1 { font-size:var(--fs-xl); margin:0; letter-spacing:-0.02em; }
  .sub { color:var(--text-muted); font-size:var(--fs-sm); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; margin-bottom:28px; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:var(--r-lg); padding:16px 18px; }
  .card .k { font-size:var(--fs-xs); color:var(--text-muted); text-transform:uppercase; letter-spacing:.08em; }
  .card .v { font-size:var(--fs-2xl); font-weight:var(--fw-bold); line-height:1.1; margin-top:6px; letter-spacing:-0.03em; }
  .card .foot { font-size:var(--fs-xs); color:var(--text-subtle); margin-top:4px; }
  h2 { font-size:var(--fs-md); margin:0 0 12px; }
  .panel { background:var(--surface); border:1px solid var(--border); border-radius:var(--r-lg); padding:18px 20px; margin-bottom:28px; }
  .step { margin-bottom:14px; }
  .step:last-child { margin-bottom:0; }
  .step-head { display:flex; justify-content:space-between; align-items:baseline; font-size:var(--fs-sm); }
  .step-value { font-weight:var(--fw-bold); font-variant-numeric:tabular-nums; }
  .track { height:8px; background:var(--surface-2); border-radius:var(--r-pill); overflow:hidden; margin-top:6px; }
  .fill { height:100%; background:var(--primary); border-radius:var(--r-pill); }
  .step-note { font-size:var(--fs-xs); color:var(--text-subtle); margin-top:4px; }
  .verdict { border-radius:var(--r-lg); padding:18px 20px; border:1px solid; margin-bottom:28px; }
  .verdict .rate { font-size:var(--fs-3xl); font-weight:var(--fw-bold); letter-spacing:-0.04em; line-height:1; }
  .verdict .line { margin-top:8px; font-size:var(--fs-sm); }
  .verdict .meta { margin-top:6px; font-size:var(--fs-xs); opacity:.75; }
  .good { border-color:var(--online); background:var(--online-tint); color:var(--online); }
  .warn { border-color:var(--warning); background:var(--warning-tint); color:var(--warning); }
  .bad  { border-color:var(--danger); background:var(--danger-tint); color:var(--danger); }
  .idle { border-color:var(--border); background:var(--surface); color:var(--text-muted); }
  footer { color:var(--text-subtle); font-size:var(--fs-xs); line-height:1.7; border-top:1px solid var(--border); padding-top:16px; }
  footer strong { color:var(--text-muted); }
  a { color:var(--primary); }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--online); display:inline-block; margin-right:6px; }
</style></head>
<body class="c-root c-stage"><div class="wrap">

<header>
  <div>
    <h1>Olumie · numbers</h1>
    <div class="sub"><span class="dot"></span>${n(s.online)} online now · counting for ${humanUptime(s.since)}</div>
  </div>
  <div class="sub">Refreshes every 30s · <a href="?format=json">JSON</a></div>
</header>

<div class="grid">
  <div class="card"><div class="k">Browsers</div><div class="v">${n(s.people)}</div><div class="foot">${n(s.returning)} came back · ${pctText(s.returnRate)}</div></div>
  <div class="card"><div class="k">Conversations</div><div class="v">${n(s.sessions)}</div><div class="foot">${n(s.teamups)} became parties</div></div>
  <div class="card"><div class="k">Peak online</div><div class="v">${n(s.peakOnline)}</div><div class="foot">at once, since last deploy</div></div>
  <div class="card"><div class="k">Reports</div><div class="v">${n(s.reports)}</div><div class="foot">${n(s.bans)} bans issued</div></div>
</div>

<h2>Where people drop off</h2>
<div class="panel">${bars}</div>

<h2>Connection health</h2>
<div class="verdict ${verdict.tone}">
  <div class="rate">${verdict.tone === 'idle' ? '—' : pctText(s.mediaFailRate)}</div>
  <div class="line">${verdict.line}</div>
  <div class="meta">${n(s.mediaFail)} failed of ${n(mediaTotal)} attempts · ${n(s.playBlocked)} blocked by autoplay (not a network fault)</div>
</div>

<footer>
  <p><strong>Read these carefully.</strong> “Page loads” counts reloads again.
  “Browsers” means browsers, not people — one person on a phone and a laptop is two,
  two people sharing a laptop is one. Private-browsing visitors aren’t counted at all.</p>
  <p><strong>Everything here resets on deploy</strong>, because the counters live in
  memory. Counting since ${new Date(s.since).toUTCString()}. For history, the server
  writes a <code>STATS</code> line to the Render logs every hour (kept 7 days).</p>
</footer>

</div>
<script>setTimeout(function () { location.reload(); }, 30000);</script>
</body></html>`;
}

// ---- report audit trail ---------------------------------------------------
// Three layers: structured server logs (Render captures them), an in-memory
// buffer viewable at /admin/reports (gated by ADMIN_KEY), and an optional
// webhook push (REPORT_WEBHOOK_URL, Discord-compatible) for a durable feed.
const recentReports = [];
const MAX_REPORTS = 500;
function logReport(rec) {
  rec.ts = new Date().toISOString();
  bump('reports');
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
  party.quietTold = false;
  searching.push(party);
  party.members.forEach((m) => send(m, { type: 'waiting' }));
}

// The searching copy promises a fast match, which an empty network can't keep.
// Someone who waits 90 seconds against a spinner concludes the site is broken,
// not quiet — so after a while, say the true thing instead. Told once per
// search; skipping or re-searching resets it along with waitingSince.
const QUIET_AFTER_MS = Math.max(5000, parseInt(process.env.QUIET_AFTER_MS || '45000', 10));

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
  // Anyone still waiting after the quiet threshold gets told the truth once.
  searching.forEach((p) => {
    if (!p.quietTold && now - (p.waitingSince || now) >= QUIET_AFTER_MS) {
      p.quietTold = true;
      p.members.forEach((m) => send(m, { type: 'quiet' }));
    }
  });
}, 2000);

function match(pA, pB) {
  const session = { parties: [pA, pB] };
  pA.session = session; pB.session = session;
  searching = searching.filter((p) => p !== pA && p !== pB);

  // Mesh: connect every cross-party pair (within-party pairs already connected).
  pA.members.forEach((a) => pB.members.forEach((b) => connectPair(a, b, false)));

  bump('sessions');
  const shared = intersect(pA.prefs.interests, pB.prefs.interests);
  [...pA.members, ...pB.members].forEach((m) => send(m, { type: 'matched', shared, size: pA.members.length + pB.members.length }));
  console.log(`Session: party#${pA.id}(${pA.members.length}) + party#${pB.id}(${pB.members.length})`);
}

// Two strangers decided to keep each other: `pA` absorbs `pB`, and the session
// they met in ends without tearing anything down. Deliberately does NOT call
// leavePair — they're already mesh-connected and that link is the whole point,
// so it's relabelled rather than rebuilt (no renegotiation, no gap in video).
// Only ever called with two solo parties, so the result is a party of 2 — the
// same shape join-by-code produces, which is why nothing downstream changes.
function mergeParties(pA, pB) {
  const session = pA.session;
  pB.members.forEach((m) => { m.party = pA; pA.members.push(m); });
  pB.members = [];
  searching = searching.filter((p) => p !== pA && p !== pB);
  if (pB.code) { partiesByCode.delete(pB.code); pB.code = null; }
  // Carry over who each of them just skipped, so the merged party doesn't get
  // handed straight back to someone either of them left.
  Object.assign(pA.recentlyLeft, pB.recentlyLeft);
  if (session) session.parties.forEach((p) => { p.session = null; });
  pA.session = null;
}
// Eligible only when it's genuinely one-on-one and neither side already has a
// party — merging is what keeps the group at 2, the size the model supports.
function canTeamUp(socket) {
  const p = socket.party;
  if (!p || !p.session || p.members.length !== 1) return null;
  const other = p.session.parties.find((x) => x !== p);
  if (!other || other.members.length !== 1) return null;
  return { p, other, peer: other.members[0] };
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
  bump('bans');
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
  if (wss.clients.size > stats.peakOnline) stats.peakOnline = wss.clients.size;

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

      // ---- Team up with the stranger you're talking to ----
      // Mutual consent only: an invite is an offer, and nothing changes until
      // the other person accepts. Held on the session, so skipping or stopping
      // discards it for free — the session object goes with it.
      case 'team-invite': {
        const ok = canTeamUp(socket);
        if (!ok) break;
        const s = socket.party.session;
        if (s.invite) break;                        // one offer at a time
        s.invite = { from: socket.peerId, at: Date.now() };
        send(ok.peer, { type: 'team-invited', peerId: socket.peerId });
        break;
      }
      case 'team-decline': {
        const ok = canTeamUp(socket);
        if (!ok) break;
        const s = socket.party.session;
        if (!s.invite || s.invite.from === socket.peerId) break;   // can't decline your own
        s.invite = null;
        send(ok.peer, { type: 'team-declined' });
        break;
      }
      case 'team-accept': {
        const ok = canTeamUp(socket);
        if (!ok) break;
        const s = socket.party.session;
        // Only the person who was invited can accept, and only their inviter.
        if (!s.invite || s.invite.from !== ok.peer.peerId) break;
        s.invite = null;
        const me = socket, them = ok.peer;
        mergeParties(ok.other, ok.p);               // inviter's party absorbs the accepter's
        send(me, { type: 'teamed', peerId: them.peerId });
        send(them, { type: 'teamed', peerId: me.peerId });
        bump('teamups');
        console.log(`Teamed up: ${me.peerId} + ${them.peerId}`);
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
        bump('starts');
        p.prefs = normalizePrefs(msg, !!socket.isPremium);
        enqueue(p);
        break;
      }

      // Aggregate counters only — a name from a fixed list, nothing else.
      // Anything unrecognised is dropped rather than counted.
      case 'stat': {
        if (STAT_EVENTS.includes(msg.name)) bump(msg.name);
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
        bump('skips');
        if (msg.interests !== undefined) p.prefs = normalizePrefs(msg, !!socket.isPremium);
        if (p.session) dissolveSession(p.session, p.session.parties.slice());   // both parties re-search
        else if (!searching.includes(p)) enqueue(p);
        break;
      }
      case 'stop': {
        const p = socket.party;
        if (!p) break;
        bump('stops');
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
  // Mint before anyone asks, so the first Start of the day doesn't wait on
  // Cloudflare. No-op unless the key env vars are set.
  cloudflareTurn();
  console.log(`\n  Olumie is running!`);
  console.log(`  Open this in your browser:  http://localhost:${PORT}\n`);
  console.log(`  Tip: open it in TWO tabs (or two windows) to match with yourself.\n`);
});
