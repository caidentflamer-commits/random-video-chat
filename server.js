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

// ---- Paid unbans ----------------------------------------------------------
// A banned visitor can pay a one-time fee to lift the ban on their IP.
// STRIPE_UNBAN_LINK is a *payment-mode* Payment Link; the client opens it with
// client_reference_id = 'unban_' + AES-GCM(ip), so the webhook can recover
// which IP paid without the IP riding in a URL or Stripe's records — and
// without storing tokens anywhere: the key derives from STRIPE_WEBHOOK_SECRET,
// so tokens survive restarts and deploys.
// Inert unless STRIPE_UNBAN_LINK and STRIPE_WEBHOOK_SECRET are both set.
const UNBAN_URL = process.env.STRIPE_UNBAN_LINK || '';
const unbanKey = process.env.STRIPE_WEBHOOK_SECRET
  ? crypto.createHash('sha256').update('unban:' + process.env.STRIPE_WEBHOOK_SECRET).digest()
  : null;
function mintUnbanToken(ip) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', unbanKey, iv);
  const ct = Buffer.concat([c.update(String(ip), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
function readUnbanToken(tok) {
  if (!unbanKey || typeof tok !== 'string') return null;
  try {
    const b = Buffer.from(tok, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', unbanKey, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }
}
// Every ban is purchasable (decided 2026-08-12). Report reasons are chosen by
// the reporter, not verified — a reason gate would just teach trolls which
// chip makes a ban permanent. Instead, the 💰 webhook ping carries the
// recorded reason, so a suspect purchase is visible for a manual re-ban.
function unbanOffer(ip) {
  return (UNBAN_URL && unbanKey && ip) ? mintUnbanToken(ip) : null;
}
// THROWS on a genuine write failure so the webhook answers 500 and Stripe shows
// a failed delivery (and retries). A green 200 that silently wrote nothing is
// the worst possible outcome to debug.
async function handleStripeEvent(event) {
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    // Paid unban: the reference is an encrypted IP, not a user id. Checked
    // first — the premium path would try to upsert it as a profile id and
    // Stripe would retry the resulting 500 forever.
    if (s.client_reference_id && s.client_reference_id.startsWith('unban_')) {
      const ip = readUnbanToken(s.client_reference_id.slice('unban_'.length));
      if (!ip) { console.warn('stripe: unban payment with unreadable token — nobody was unbanned'); return; }
      // Best-effort: what was this ban for? Rides in the log + Discord ping so
      // a purchase worth a second look (e.g. an "Under 18" report) is visible.
      let reason = '';
      if (supa) {
        try {
          const { data } = await supa.from('bans').select('reason').eq('ip', ip)
            .order('id', { ascending: false }).limit(1);
          reason = (data && data[0] && data[0].reason) || '';
        } catch {}
      }
      bannedIps.delete(ip);
      if (supa) {
        // Expire rather than delete: the ban history stays auditable.
        const { error } = await supa.from('bans')
          .update({ expires_at: new Date().toISOString() }).eq('ip', ip);
        if (error) throw new Error(`unban expire failed for ${ip}: ${error.message}`);
      }
      bump('unbans');
      console.log(`UNBAN paid: ${ip}${reason ? ` (was banned for: ${reason})` : ''}`);
      const hook = process.env.REPORT_WEBHOOK_URL;
      if (hook && typeof fetch === 'function') {
        try { fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `💰 Paid unban: ${ip}${reason ? ` — was banned for: **${reason}**` : ''}` }) }).catch(() => {}); } catch {}
      }
      return;
    }
    if (!supa) return;
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
    // A conversion a creator gets paid for. The durable record is the profiles
    // row itself (referred_by + is_premium); this is the visible ping so a
    // payable event isn't something you discover by running a query later.
    try {
      const { data: prof } = await supa.from('profiles').select('referred_by').eq('id', userId).maybeSingle();
      if (prof && prof.referred_by) {
        console.log(`REFERRAL conversion: ${prof.referred_by} → ${userId}`);
        const hook = process.env.REPORT_WEBHOOK_URL;
        if (hook && typeof fetch === 'function') {
          try { fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `💸 Referral conversion: **${prof.referred_by}** brought a Premium subscriber` }) }).catch(() => {}); } catch {}
        }
      }
    } catch {}
  } else if (event.type === 'customer.subscription.deleted' ||
    (event.type === 'customer.subscription.updated' && ['canceled', 'unpaid', 'incomplete_expired'].includes(event.data.object.status))) {
    if (!supa) return;
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
async function handleAuth(socket, token, ref) {
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
    stampReferral(socket.userId, ref);   // credit the creator whose link brought them (set once)
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

// Sent on every response, including the API ones. 'unsafe-inline' and
// 'unsafe-eval' are both unavoidable here — the whole app is one inline
// <script>, and TensorFlow.js needs eval; without it nsfwjs fails to load and
// moderation fails *open*, silently, which is worse than the eval. So this CSP
// is not an XSS backstop. What it does buy: frame-ancestors (nobody wraps a
// camera prompt in their own page), object-src, base-uri, and a fixed list of
// hosts allowed to serve script.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
  // clarity.css pulls Inter + JetBrains Mono from Google Fonts via @import;
  // the stylesheet comes from googleapis, the font files from gstatic.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  // Supabase auth, the tfjs/nsfwjs bundles, and the NSFW model weights —
  // nsfwjs.load() with no argument pulls those from that CloudFront bucket.
  "connect-src 'self' https://cdn.jsdelivr.net https://*.supabase.co",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function setSecurityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');            // for anything older than frame-ancestors
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=()');
  // Only meaningful over TLS, and Render terminates it in front of us.
  if (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
}

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  setSecurityHeaders(req, res);

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

  // Discord interactions. Every button press and slash command lands here.
  if (req.method === 'POST' && urlPath === '/discord/interactions') {
    const chunks = [];
    req.on('data', (c) => { chunks.push(c); if (chunks.length > 200) req.destroy(); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      // 401 specifically — Discord disables an endpoint that doesn't reject
      // its deliberately-bad probe requests.
      if (!discordSignatureOk(req, raw)) { res.writeHead(401); return res.end('invalid request signature'); }
      let body = {};
      try { body = JSON.parse(raw.toString() || '{}'); } catch {}
      const reply = (payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const EPHEMERAL = 64;
      const say = (content) => reply({ type: 4, data: { content, flags: EPHEMERAL } });

      if (body.type === 1) return reply({ type: 1 });                        // PING

      const user = (body.member && body.member.user) || body.user || {};
      const allowed = discordAdminIds();
      if (!allowed.length) return say('DISCORD_ADMIN_IDS is not set, so nobody is allowed to act. Set it to your Discord user ID on Render.');
      if (!allowed.includes(String(user.id))) return say('You are not on the admin list for this app.');

      if (body.type === 3) {                                                 // MESSAGE_COMPONENT
        const [scope, action, id] = String((body.data && body.data.custom_id) || '').split(':');
        if (scope !== 'review') return say('Unknown button.');
        const out = decideReview(id, action, user.username || user.id);
        const original = (body.message && body.message.embeds && body.message.embeds[0]) || {};
        // Edit the card in place and drop the buttons, so the channel shows
        // what was decided instead of a stale pair of tempting buttons.
        return reply({
          type: 7,
          data: {
            embeds: [{ ...original, color: out.ok && action === 'ban' ? 0x7f1d1d : 0x2b2f3a,
              footer: { text: `${out.text} — by ${user.username || user.id}` } }],
            components: [],
          },
        });
      }

      if (body.type === 2) {                                                 // APPLICATION_COMMAND
        const name = (body.data && body.data.name) || '';
        if (name === 'stats') return say(discordStatsText());
        if (name === 'queue') {
          const open = reviewQueue.filter((r) => r.status === 'open').slice().reverse();
          if (!open.length) return say('Queue is empty.');
          // Re-post the oldest few as fresh cards so they can be acted on here.
          open.slice(0, 5).reverse().forEach((it) => discordSend(body.channel_id, reviewCard(it)));
          return say(`${open.length} waiting — reposting the ${Math.min(5, open.length)} most recent as cards.`);
        }
        if (name === 'whoami') {
          return say([
            'What the server thinks your address is — every ban is keyed on this.',
            `\`\`\`json\n${JSON.stringify({ trustedProxyHops: TRUSTED_PROXY_HOPS, note: 'open /admin/whoami?key=… from a phone on cell data to check a real client IP' }, null, 2)}\n\`\`\``,
          ].join('\n'));
        }
        return say('Unknown command.');
      }
      return reply({ type: 4, data: { content: 'Unhandled interaction type.', flags: EPHEMERAL } });
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
    if (ua && !BOT_RE.test(ua)) {
      bump('visits');
      // Creator link click (?r=name). Same bot filter as visits — a creator's
      // link pasted in a stream chat gets preview-fetched by every platform.
      countRefClick(new URLSearchParams((req.url.split('?')[1] || '')).get('r'));
    }
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
      unbanUrl: UNBAN_URL,                                 // one-time paid-unban checkout link
    }));
  }

  // Moderation report log (JSON). Gated by ?key=<ADMIN_KEY>; disabled if unset.
  if (urlPath === '/admin/reports') {
    if (!adminKeyOk(req, new URLSearchParams((req.url.split('?')[1] || '')))) { res.writeHead(403); return res.end('Forbidden'); }
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

  // There is no admin web page any more — Discord is the control surface, and
  // a report arrives there as a card with Ban / Dismiss on it. What is left
  // under /admin is JSON, for curl and for anything scripted.
  if (urlPath === '/admin' || urlPath === '/admin/') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      surface: 'Discord — see DISCORD.md. Buttons on each queued report; /stats and /queue as slash commands.',
      json: ['/admin/data', '/admin/stats', '/admin/review', '/admin/reports', '/admin/whoami'],
      note: 'All take ?key=ADMIN_KEY or an X-Admin-Key header.',
    }, null, 2));
  }
  // Everything in one round trip, for when you do want to look at raw numbers.
  if (urlPath === '/admin/data') {
    const q = new URLSearchParams((req.url.split('?')[1] || ''));
    if (!adminKeyOk(req, q)) { res.writeHead(403); return res.end('Forbidden'); }
    return referralPayouts().then((payouts) => {
      const summary = statsSummary();
      summary.referrals = {};
      const refs = new Set([...refClicks.keys(), ...Object.keys(payouts || {})]);
      refs.forEach((r) => {
        summary.referrals[r] = { clicks: refClicks.get(r) || 0, ...(payouts && payouts[r] ? payouts[r] : { accounts: null, paying: null }) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        stats: summary,
        review: reviewQueue.filter((r) => r.status === 'open').slice().reverse(),
        reports: recentReports.slice(-60).reverse(),
        bans: bannedIps.size,
        conn: {
          clientIp: getClientIp(req),
          trustedProxyHops: TRUSTED_PROXY_HOPS,
          xForwardedFor: forwardedChain(req),
          socketRemote: req.socket.remoteAddress || null,
        },
      }));
    });
  }

  // The review queue as JSON, plus the POST that acts on an entry. The Discord
  // buttons are the normal way in; this is the same decision by curl. It stays a
  // POST so no prefetch, link preview or <img> in a chat can fire it.
  if (urlPath === '/admin/review' || urlPath === '/admin/review/act') {
    const q = new URLSearchParams((req.url.split('?')[1] || ''));
    if (!adminKeyOk(req, q)) { res.writeHead(403); return res.end('Forbidden'); }
    if (urlPath === '/admin/review/act') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
      const chunks = [];
      req.on('data', (c) => { chunks.push(c); if (chunks.length > 50) req.destroy(); });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
        const out = decideReview(body.id, body.action, 'curl');
        if (!out.ok) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: out.text })); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: out.item.id, status: out.item.status }));
      });
      return;
    }
    const open = reviewQueue.filter((r) => r.status === 'open').slice().reverse();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ open: open.length, total: reviewQueue.length, items: open }, null, 2));
  }

  // One-hit check that TRUSTED_PROXY_HOPS matches whatever is in front of us:
  // open it from a phone on cell data and confirm clientIp is that phone's
  // public address and not something a header invented. Every ban is keyed on
  // this value, so it is worth being sure rather than assuming.
  if (urlPath === '/admin/whoami') {
    if (!adminKeyOk(req, new URLSearchParams((req.url.split('?')[1] || '')))) { res.writeHead(403); return res.end('Forbidden'); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      clientIp: getClientIp(req),
      trustedProxyHops: TRUSTED_PROXY_HOPS,
      xForwardedFor: forwardedChain(req),
      socketRemote: req.socket.remoteAddress || null,
    }, null, 2));
  }

  // Aggregate usage counters. Same ADMIN_KEY gate as /admin/reports, and the
  // same "inert until the env var is set" rule as everything else here.
  if (urlPath === '/admin/stats') {
    const q = new URLSearchParams((req.url.split('?')[1] || ''));
    if (!adminKeyOk(req, q)) { res.writeHead(403); return res.end('Forbidden'); }
    // Referral payouts come from Supabase (durable — money), the rest from the
    // in-memory counters; the page shows both side by side.
    return referralPayouts().then((payouts) => {
      const summary = statsSummary();
      summary.referrals = {};
      const refs = new Set([...refClicks.keys(), ...Object.keys(payouts || {})]);
      refs.forEach((r) => {
        summary.referrals[r] = { clicks: refClicks.get(r) || 0, ...(payouts && payouts[r] ? payouts[r] : { accounts: null, paying: null }) };
      });
      // HTML by default (this gets opened in a browser); JSON on request so
      // curl and anything scripted keeps working exactly as before.
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(summary, null, 2));
    });
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

// maxPayload: ws defaults to 100 MB per frame. Nothing we send is bigger than
// an SDP blob, so the default was only ever an invitation to fill the
// instance's memory from a single socket.
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
// Same reasoning as the per-socket handler below: an unhandled 'error' is fatal.
wss.on('error', (err) => console.error('ws server error:', err && err.message));
// Malformed HTTP before the socket exists (bad request line, oversized headers)
// lands here instead, and is just as fatal if nobody is listening.
server.on('clientError', (err, sock) => {
  try { sock.destroy(); } catch {}
});

let searching = [];                 // parties currently in matchmaking (not in a session)
const partiesByCode = new Map();    // join code -> party awaiting a second member
const bannedIps = new Set();
let nextId = 1;

const FALLBACK_MS = 6000;           // pair long-waiting parties regardless of interests
const REPORT_LAST_GRACE_MS = 30000; // how long a just-left stranger can still be reported
const RECENT_COOLDOWN_MS = 8000;    // don't instantly re-match the party you just skipped

// ---- small utilities ------------------------------------------------------

// X-Forwarded-For is a list the client can start and every proxy APPENDS to,
// so the rightmost entries are the ones our own infrastructure wrote and the
// leftmost is whatever the caller made up. Reading [0] meant a header could
// name any address: free ban evasion, and — because bans are keyed by IP — the
// ability to get an innocent address banned by claiming to be it. Count hops in
// from the right instead; with one proxy in front of us (Render's) the last
// entry is the real peer. Confirm the count on a given host with
// /admin/whoami?key=ADMIN_KEY before touching TRUSTED_PROXY_HOPS.
const TRUSTED_PROXY_HOPS = Math.max(1, parseInt(process.env.TRUSTED_PROXY_HOPS || '1', 10));
function forwardedChain(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
}
function getClientIp(req) {
  const fwd = forwardedChain(req);
  if (fwd.length) return fwd[Math.max(0, fwd.length - TRUSTED_PROXY_HOPS)];
  return req.socket.remoteAddress || 'unknown';
}

// ---- flood control --------------------------------------------------------
// Sockets are free to open and cost us memory, and the message handler does as
// much work as it is asked to. Neither limit below is reachable by a real
// household — a party of four on one Wi-Fi is four sockets — but both are
// reachable in a second by a loop.
const MAX_SOCKETS_PER_IP = 8;
const CONNECTS_PER_IP_PER_MIN = 40;
const MSG_BURST = 400;              // sized for a 4-way mesh trickling ICE for three peer connections
const MSG_REFILL_PER_SEC = 40;
const socketsPerIp = new Map();
const connectTimes = new Map();

function admitConnection(ip) {
  const now = Date.now();
  const times = (connectTimes.get(ip) || []).filter((t) => now - t < 60000);
  connectTimes.set(ip, times);
  if (times.length >= CONNECTS_PER_IP_PER_MIN) return false;
  if ((socketsPerIp.get(ip) || 0) >= MAX_SOCKETS_PER_IP) return false;
  times.push(now);
  socketsPerIp.set(ip, (socketsPerIp.get(ip) || 0) + 1);
  if (connectTimes.size > 5000) {
    for (const [k, v] of connectTimes) { if (!v.some((t) => now - t < 60000)) connectTimes.delete(k); }
  }
  return true;
}
function releaseConnection(ip) {
  const left = (socketsPerIp.get(ip) || 1) - 1;
  if (left > 0) socketsPerIp.set(ip, left); else socketsPerIp.delete(ip);
}
function spendToken(socket) {
  const now = Date.now();
  const refill = Math.floor(((now - socket.lastRefill) / 1000) * MSG_REFILL_PER_SEC);
  if (refill >= 1) { socket.tokens = Math.min(MSG_BURST, socket.tokens + refill); socket.lastRefill = now; }
  if (socket.tokens <= 0) return false;
  socket.tokens--;
  return true;
}
// The key may arrive as a header instead of a query string. That is what the
// /admin hub uses, which keeps ADMIN_KEY out of URLs — and so out of access
// logs, Referer headers, browser history and anything that shoulder-surfs a
// address bar. The ?key= form still works; every doc and bookmark uses it.
function adminKeyOk(req, q) {
  const key = req.headers['x-admin-key'] || (q && q.get('key')) || '';
  return !!process.env.ADMIN_KEY && key === process.env.ADMIN_KEY;
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

// ---- creator referrals ----------------------------------------------------
// Creators promote with olumie.chat/?r=name. Two halves, deliberately split:
//   • Clicks per creator — in-memory like the other counters (resets on
//     deploy; the hourly STATS line is the history). Vanity numbers.
//   • Paying subscribers per creator — DURABLE, because money rides on it.
//     The ref is stamped onto profiles.referred_by at sign-in (set once,
//     never overwritten: the creator who brought the account keeps the
//     credit) and payouts are read straight from Supabase — a deploy can't
//     erase who is owed what.
// Inert without Supabase + a `referred_by` column (SQL in HANDOFF), like
// everything else here.
const REF_RE = /^[a-z0-9_-]{2,32}$/i;
const refClicks = new Map();
const MAX_REFS = 200;   // a flood of made-up refs shouldn't grow this forever
function countRefClick(ref) {
  if (typeof ref !== 'string' || !REF_RE.test(ref)) return;
  const key = ref.toLowerCase();
  if (!refClicks.has(key) && refClicks.size >= MAX_REFS) return;
  refClicks.set(key, (refClicks.get(key) || 0) + 1);
}
let refColumnMissing = false;   // warn once, not per sign-in
async function stampReferral(userId, ref) {
  if (!supa || refColumnMissing || typeof ref !== 'string' || !REF_RE.test(ref)) return;
  try {
    // Conditional update, not upsert: only fills an empty referred_by, so an
    // account's original creator can't be overwritten by a later click.
    const { error } = await supa.from('profiles')
      .update({ referred_by: ref.toLowerCase() })
      .eq('id', userId).is('referred_by', null);
    if (error) throw error;
  } catch (e) {
    if (/referred_by/.test(e.message || '')) {
      if (!refColumnMissing) console.warn('referrals: profiles.referred_by column missing — run the SQL in HANDOFF.md to enable');
      refColumnMissing = true;
    } else console.warn('referrals: stamp failed:', e.message);
  }
}
// Paying subscribers per creator, straight from the durable record.
async function referralPayouts() {
  if (!supa || refColumnMissing) return null;
  try {
    const { data, error } = await supa.from('profiles')
      .select('referred_by, is_premium').not('referred_by', 'is', null);
    if (error) throw error;
    const out = {};
    (data || []).forEach((r) => {
      const o = out[r.referred_by] || (out[r.referred_by] = { accounts: 0, paying: 0 });
      o.accounts++; if (r.is_premium) o.paying++;
    });
    return out;
  } catch (e) {
    if (/referred_by/.test(e.message || '')) refColumnMissing = true;
    else console.warn('referrals: payout read failed:', e.message);
    return null;
  }
}
const STAT_EVENTS = ['gate', 'mediaOk', 'mediaFail', 'playBlocked'];
const stats = {
  since: new Date().toISOString(),
  visits: 0, people: 0, returning: 0, gate: 0, starts: 0, sessions: 0, teamups: 0,
  skips: 0, stops: 0, mediaOk: 0, mediaFail: 0, playBlocked: 0,
  reports: 0, bans: 0, unbans: 0, peakOnline: 0,
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

// ---- Discord control surface ----------------------------------------------
// The admin surface is Discord, not a web page. A queued report arrives as a
// card with Ban / Dismiss on it, so acting on one is a notification and a tap.
//
// It has to be a BOT, not the old incoming webhook: Discord only lets
// application-owned senders attach interactive components — a plain channel
// webhook has its `components` field ignored outright. Inert until
// DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID are set, like everything else here;
// REPORT_WEBHOOK_URL still works and is still used for the plain pings.
const DISCORD_API = 'https://discord.com/api/v10';
const discordReady = () => !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CHANNEL_ID);
// Who is allowed to press the buttons. Anyone can SEE the channel; that is not
// the same as being allowed to ban someone. Unset means nobody — fail closed,
// because the alternative is every member of the server holding the ban hammer.
function discordAdminIds() {
  return String(process.env.DISCORD_ADMIN_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
}

async function discordSend(channelId, payload) {
  if (!process.env.DISCORD_BOT_TOKEN) return null;
  try {
    const r = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.error(`discord send failed ${r.status} to channel ${channelId}: ${(await r.text()).slice(0, 200)}`);
    return r.ok;
  } catch (e) { console.error('discord send error:', e && e.message); return false; }
}

// One card per queued report. custom_id carries the decision and the item id —
// that is all the state a button needs, so a redeploy doesn't orphan the
// buttons already sitting in the channel.
function reviewCard(item) {
  const v = item.verdict;
  const h = item.history;
  const lines = [
    `**Target** \`${item.targetIp}\`  ·  **Reporter** \`${item.reporterIp}\``,
    `**History** ${historyLine(h) || 'unknown'}`,
    `**Why it's here** ${item.why || 'n/a'}`,
    v ? `**Verdict** ${v.frames} frame(s) · ${Object.entries(v.scores).map(([k, n]) => `${k} ${n}`).join(' · ')}`
      : '**Verdict** none — judge on the report alone',
  ];
  if (item.note) lines.push(`**Note** ${String(item.note).replace(/`/g, "'").slice(0, 300)}`);
  return {
    embeds: [{
      title: `Review #${item.id} · ${item.reason || 'unspecified'}`,
      description: lines.join('\n'),
      // Red only when more than one person independently flagged them. A lone
      // report should not look like a verdict before you have read it.
      color: h && h.reporters >= 2 ? 0x7f1d1d : 0x3d4354,
      timestamp: item.ts,
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 4, label: 'Ban this IP', custom_id: `review:ban:${item.id}` },
        { type: 2, style: 2, label: 'Dismiss', custom_id: `review:dismiss:${item.id}` },
      ],
    }],
  };
}

// Applies a decision from either surface. Returns a line describing what
// happened so the caller can show it wherever the press came from.
function decideReview(id, action, who) {
  const item = reviewQueue.find((r) => r.id === Number(id));
  if (!item) return { ok: false, text: `#${id} is gone — the queue empties on deploy.` };
  if (item.status !== 'open') return { ok: false, text: `#${id} was already ${item.status}.` };
  if (action === 'ban') {
    if (!banIp(item.targetIp, `review #${item.id}: ${item.reason || 'manual'}`, null)) {
      return { ok: false, text: `\`${item.targetIp}\` is on the exempt list — not banned.` };
    }
    item.status = 'banned';
    // banSocket() is what normally counts a ban, and it only runs for someone
    // still connected. A decision made from the queue an hour later has nobody
    // to disconnect, so count it here or the number quietly under-reports.
    bump('bans');
    // countIt=false: already counted above, and this is the same ban.
    wss.clients.forEach((c) => { if (c.ip === item.targetIp && c.readyState === c.OPEN) banSocket(c, false); });
  } else if (action === 'dismiss') {
    item.status = 'dismissed';
  } else return { ok: false, text: 'Unknown action.' };
  item.decidedAt = new Date().toISOString();
  item.decidedBy = who || 'admin';
  console.log(`REVIEW-ACT ${item.status} #${item.id} ${item.targetIp} by ${item.decidedBy}`);
  return { ok: true, item, text: item.status === 'banned' ? `Banned \`${item.targetIp}\`` : 'Dismissed' };
}

// Discord signs every interaction; an unsigned or badly signed one is either a
// misconfiguration or someone probing the endpoint, and Discord itself sends
// deliberately-invalid requests to check we reject them. Raw bytes only — the
// signature covers the exact body, so this cannot be done after JSON.parse.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function discordSignatureOk(req, raw) {
  const pub = process.env.DISCORD_PUBLIC_KEY;
  const sig = req.headers['x-signature-ed25519'];
  const ts = req.headers['x-signature-timestamp'];
  if (!pub || !sig || !ts) return false;
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pub, 'hex')]),
      format: 'der', type: 'spki',
    });
    return crypto.verify(null, Buffer.concat([Buffer.from(ts), raw]), key, Buffer.from(sig, 'hex'));
  } catch (e) { console.warn('discord signature check failed:', e && e.message); return false; }
}

function discordStatsText() {
  const st = statsSummary();
  const open = reviewQueue.filter((r) => r.status === 'open').length;
  return [
    `**Online** ${st.online}  ·  **Peak** ${st.peakOnline}`,
    `**Page loads** ${st.visits}  ·  **Browsers** ${st.people}  ·  **Started** ${st.starts}${st.startRate == null ? '' : ` (${st.startRate}%)`}`,
    `**Sessions** ${st.sessions}  ·  **Skips** ${st.skips}  ·  **Reports** ${st.reports}  ·  **Bans** ${st.bans}`,
    `**Queue** ${open} waiting  ·  **Banned IPs held** ${bannedIps.size}`,
    `_counting since ${new Date(st.since).toUTCString()} — resets on deploy_`,
  ].join('\n');
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
  notify(`🚩 **${rec.kind}** · reason: ${rec.reason || 'n/a'}${rec.note ? ` · note: ${rec.note}` : ''} · reporter ${rec.reporter} → ${rec.target || rec.targetIp || 'n/a'} · ${rec.action}`);
}
function notify(line) {
  const hook = process.env.REPORT_WEBHOOK_URL;
  if (!hook || typeof fetch !== 'function') return;
  try { fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: line.slice(0, 1900) }) }).catch(() => {}); } catch {}
}

// ---- human review queue ---------------------------------------------------
// Everything that did NOT earn an automatic ban lands here instead of being
// thrown away: every non-visual reason (nobody can classify "this person is
// 14" or "they want my Cash App" from a frame), plus visual reports whose
// verdict came back clean or missing. Nothing here has banned anyone — it is
// a list of things for a human to decide on.
const reviewQueue = [];
const MAX_REVIEW = 500;
let reviewSeq = 1;

// The strongest thing a moderator has, given they cannot see the frame: one
// stranger reporting someone is weak, but four unrelated people inside an hour
// is stronger evidence than any single image — and unlike a report or a note, a
// lone griefer cannot manufacture it.
//
// Distinct REPORTERS matters more than the raw count: ten reports from one
// address is one person with a grudge, three from three addresses is a pattern.
const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function targetHistory(ip) {
  // In-memory first — always available, and it definitely contains the report
  // being queued right now, which the durable copy may not yet: logReport()
  // fires dbInsertReport() without awaiting it, so the row can still be in
  // flight. The two are merged rather than picked between, so the race cannot
  // make a repeat offender look like a first-timer.
  const local = new Set();
  let localCount = 0;
  recentReports.forEach((r) => {
    if (r.targetIp !== ip) return;
    localCount++;
    if (r.reporterIp) local.add(r.reporterIp);
  });
  const out = { reports: localCount, reporters: local.size, durable: false, windowDays: 7 };
  if (!supa) return out;
  try {
    const since = new Date(Date.now() - HISTORY_WINDOW_MS).toISOString();
    const { data, error } = await supa
      .from('reports').select('reporter_ip').eq('target_ip', ip).gte('created_at', since);
    if (error || !data) return out;
    const all = new Set(local);
    data.forEach((r) => { if (r.reporter_ip) all.add(r.reporter_ip); });
    out.reports = Math.max(localCount, data.length);
    out.reporters = all.size;
    out.durable = true;
  } catch (e) { console.warn('history lookup failed:', e && e.message); }
  return out;
}

function historyLine(h) {
  if (!h) return null;
  if (h.reports <= 1) return 'First report against this address' + (h.durable ? ' in ' + h.windowDays + ' days.' : ' this session.');
  const who = h.reporters > 1 ? h.reporters + ' different reporters' : 'one reporter';
  const flag = h.reporters >= 3 ? ' — a pattern, not a grudge' : '';
  return h.reports + ' reports from ' + who + (h.durable ? ' in ' + h.windowDays + ' days' : ' this session') + flag;
}

function queueReview(rec) {
  const item = { id: reviewSeq++, ts: new Date().toISOString(), status: 'open', ...rec };
  reviewQueue.push(item);
  if (reviewQueue.length > MAX_REVIEW) reviewQueue.shift();
  console.log('REVIEW ' + JSON.stringify(item));
  postReviewCard(item);   // async: needs a history lookup before it can render
  return item;
}

// Async because the history lookup hits Supabase. Nothing waits on this — the
// reporter already got their ack and left the room.
async function postReviewCard(item) {
  item.history = await targetHistory(item.targetIp);
  // With the bot configured this is an actionable card; otherwise the old
  // one-line ping. Crucially the ping is ALSO the fallback when the card fails
  // to send — a wrong token or channel id used to mean the report reached
  // Discord in no form whatsoever, which is the worst way for a moderation
  // queue to break, because it looks like quiet rather than broken.
  const hist = historyLine(item.history);
  const line = `📋 **Review queued** (#${item.id}) · ${item.reason || 'n/a'}${item.note ? ` · "${item.note}"` : ''} · target ${item.targetIp}${item.verdict ? ` · scores ${JSON.stringify(item.verdict.scores || {})}` : ' · no verdict'}${hist ? ` · ${hist}` : ''}`;
  if (!discordReady()) return notify(line);
  const ok = await discordSend(process.env.DISCORD_CHANNEL_ID, reviewCard(item));
  if (!ok) {
    console.error(`REVIEW #${item.id} card failed to post — falling back to the webhook. Run tools/discord_selftest.js.`);
    notify('⚠️ card failed to post — ' + line);
  }
}

// A report only bans on its own when a visual reason came back with a positive
// classification from the reporter's own browser. That verdict is client-
// supplied — this is a P2P mesh, no frame ever reaches the server, so there is
// nothing here to independently verify with. It raises the bar a long way past
// one click; mayBan()'s budgets are what stop someone who forges it wholesale.
const VISUAL_REASONS = new Set(['Nudity']);
function confirmedExplicit(msg) {
  const reason = String(msg.reason || '');
  const visual = reason.startsWith('auto:') || VISUAL_REASONS.has(reason);
  if (!visual) return { ban: false, why: 'non-visual reason — review only' };
  const v = msg.verdict;
  if (!v || typeof v !== 'object') return { ban: false, why: 'no verdict supplied' };
  if (v.explicit !== true) return { ban: false, why: 'verdict came back clean' };
  return { ban: true, why: 'confirmed explicit', verdict: sanitizeVerdict(v) };
}
// Never store the client's object as-is — it is attacker-shaped input that
// ends up in an admin page and a webhook.
function sanitizeVerdict(v) {
  const scores = {};
  if (v && v.scores && typeof v.scores === 'object') {
    for (const k of ['Porn', 'Hentai', 'Sexy', 'Neutral', 'Drawing']) {
      const n = Number(v.scores[k]);
      if (Number.isFinite(n)) scores[k] = Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
    }
  }
  return { explicit: v.explicit === true, frames: Math.min(10, Math.max(0, parseInt(v.frames, 10) || 0)), scores };
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
    // peerId rides along so a "report the last person" pick identifies ONE of
    // them. Without it the only handle was the IP list, which is why that path
    // used to ban the whole batch.
    a.lastOpponents = (a.lastOpponents || []).concat({ ip: b.ip, at: now, peerId: b.peerId });
    b.lastOpponents = (b.lastOpponents || []).concat({ ip: a.ip, at: now, peerId: a.peerId });
  }));
  pA.session = null; pB.session = null;
  pA.recentlyLeft[pB.id] = now; pB.recentlyLeft[pA.id] = now;   // no instant re-match
  reenqueue.forEach((p) => { if (p && p.members.length) enqueue(p); });
}

// ---- moderation / bans ----------------------------------------------------

// A report bans instantly, by IP, durably — exactly right for a real flasher,
// and catastrophic in a loop. Nothing used to stop a script running
// search → match → report → next and burning a genuine user every few seconds;
// since the only way back in is the paid unban link, the griefing even came
// with a price tag attached. Two brakes below. Both throttle the *ban*, never
// the report: a throttled report is still logged, still webhooked, still in
// /admin/reports — it just stops pulling the trigger by itself.
const REPORTER_BAN_BUDGET = 5;                  // bans one reporter IP can cause…
const REPORTER_WINDOW_MS = 60 * 60 * 1000;      // …per hour
const GLOBAL_BAN_BUDGET = 30;                   // site-wide bans per hour before the breaker trips
const banTimesByReporter = new Map();           // reporter ip -> when the bans it caused happened
let globalBanTimes = [];
let breakerNotifiedAt = 0;

function withinWindow(times, now) { return times.filter((t) => now - t < REPORTER_WINDOW_MS); }

// `cost` is how many IPs this action wants to ban — report-last asks for
// several at once. All-or-nothing: a request that doesn't fit the remaining
// budget is refused whole rather than half-applied.
function mayBan(reporterIp, cost) {
  const now = Date.now();
  globalBanTimes = withinWindow(globalBanTimes, now);
  if (globalBanTimes.length + cost > GLOBAL_BAN_BUDGET) {
    // Site-wide brake. If this trips, either something has gone badly wrong or
    // someone is attacking the moderation system — both want a human, so it
    // shouts once per window instead of quietly swallowing reports.
    if (now - breakerNotifiedAt > REPORTER_WINDOW_MS) {
      breakerNotifiedAt = now;
      console.error(`BAN BREAKER TRIPPED — ${globalBanTimes.length} bans in the last hour; auto-bans paused, reports still recorded.`);
      notify(`🛑 **Ban breaker tripped** — ${globalBanTimes.length} bans in the last hour. Auto-bans are paused; reports are still being recorded. Check /admin/reports.`);
    }
    return { ok: false, reason: 'site ban rate exceeded' };
  }
  const mine = withinWindow(banTimesByReporter.get(reporterIp) || [], now);
  banTimesByReporter.set(reporterIp, mine);
  if (mine.length + cost > REPORTER_BAN_BUDGET) return { ok: false, reason: 'reporter ban budget exceeded' };
  for (let i = 0; i < cost; i++) { mine.push(now); globalBanTimes.push(now); }
  if (banTimesByReporter.size > 5000) {
    for (const [ip, times] of banTimesByReporter) { if (!withinWindow(times, now).length) banTimesByReporter.delete(ip); }
  }
  return { ok: true };
}

// Two lists, because they cover two different moments.
//
// BAN_EXEMPT_USER_IDS is the precise one — a Supabase user id, already verified
// server-side by supabase.auth.getUser(), so it follows you across your laptop,
// your phone and any network. But it is useless once you are already banned:
// the ban is enforced when the socket connects, before anyone has authenticated.
//
// BAN_EXEMPT_IPS is what gets you back through the door, and it is the one to be
// careful with. On cell data you are usually behind CGNAT sharing an address
// with thousands of strangers — exempt that and you have quietly made a chunk of
// a carrier unbannable. Home IP here; use the user-id list for mobile.
const listFromEnv = (name) => String(process.env[name] || '').split(',').map((x) => x.trim()).filter(Boolean);
function ipExempt(ip) { return listFromEnv('BAN_EXEMPT_IPS').includes(ip); }
function socketExempt(socket) {
  if (!socket) return false;
  if (ipExempt(socket.ip)) return true;
  return !!socket.userId && listFromEnv('BAN_EXEMPT_USER_IDS').includes(socket.userId);
}

// Every path that can ban goes through here — report, report-last, and a
// decision from the queue. One gate, so a fourth path added later cannot
// silently skip the check.
function banIp(ip, reason, socket) {
  if (ipExempt(ip) || socketExempt(socket)) {
    const who = socket && socket.userId ? ' user ' + socket.userId : '';
    console.warn('BAN SKIPPED (exempt) ' + ip + who + ' — would have been: ' + reason);
    return false;
  }
  bannedIps.add(ip);
  dbInsertBan(ip, reason);
  return true;
}

function banSocket(socket, countIt) {
  // Every caller already went through banIp(), so this is belt and braces —
  // but this is the function whose name says "ban this person", and it adds to
  // bannedIps itself. Anyone reaching for it directly in future should not be
  // able to bypass the exemption by accident.
  if (socketExempt(socket)) { console.warn('BAN SKIPPED (exempt) ' + socket.ip + ' — banSocket called directly'); return; }
  if (countIt !== false) bump('bans');
  bannedIps.add(socket.ip);
  console.log(`Banned IP ${socket.ip} (${socket.peerId})`);
  // The unban token must ride IN the banned message — the client tears the
  // socket down as soon as it sees one, so a follow-up would never arrive.
  send(socket, { type: 'banned', unban: unbanOffer(socket.ip) || undefined });
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
  socket.tokens = MSG_BURST;
  socket.lastRefill = Date.now();

  // Cheap floods first — one machine holding sockets open, or reconnecting in a
  // tight loop, costs the attacker nothing and costs a $7 instance everything.
  if (!admitConnection(socket.ip)) {
    console.warn(`Refused connection from ${socket.ip} — per-IP limit`);
    return socket.close(1013, 'too many connections');
  }
  socket.counted = true;

  // Only the IP list can help here — nobody has authenticated yet.
  if (bannedIps.has(socket.ip) && !ipExempt(socket.ip)) {
    send(socket, { type: 'banned', unban: unbanOffer(socket.ip) || undefined });
    return socket.close();
  }
  // Durable ban check (survives restarts). Fast in-memory check above covers the
  // common case; this catches bans persisted before this process started.
  dbIsBanned(socket.ip).then((banned) => {
    if (banned && !ipExempt(socket.ip) && socket.readyState === socket.OPEN) { bannedIps.add(socket.ip); send(socket, { type: 'banned', unban: unbanOffer(socket.ip) || undefined }); socket.close(); }
  });
  console.log(`Connected ${socket.peerId} (${socket.ip})`);
  if (wss.clients.size > stats.peakOnline) stats.peakOnline = wss.clients.size;

  // In Node an 'error' event with no listener is rethrown and kills the
  // process — so a single oversized frame, protocol violation or abrupt reset
  // from ONE visitor took the whole site down with it. ws surfaces those on the
  // socket, which is why this has to be here and not only on the server.
  socket.on('error', (err) => {
    console.warn(`Socket error ${socket.peerId} (${socket.ip}): ${err && err.message}`);
    try { socket.close(); } catch {}
  });

  socket.on('message', (raw) => {
    // Token bucket, sized for the real worst case: a 4-way mesh trickling ICE
    // candidates across three peer connections at once. Past that it's a
    // script, and a script that ignores the brake gets dropped.
    if (!spendToken(socket)) {
      console.warn(`Rate-limited ${socket.peerId} (${socket.ip}) — closing`);
      return socket.close(1008, 'slow down');
    }
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
        handleAuth(socket, msg.token, msg.ref);
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
        const reason = String(msg.reason || '').slice(0, 80);
        const note = String(msg.note || '').slice(0, 200);
        const check = confirmedExplicit(msg);
        // Two independent gates, in this order: the report must have earned a
        // ban at all, and only then does the rate budget get consulted. A
        // report that was never going to ban must not burn budget.
        const gate = check.ban ? mayBan(socket.ip, 1) : { ok: false, reason: check.why };
        // Decide first, log what actually happened second — logging from the
        // gate alone recorded "banned" for bans the exemption then refused.
        const banned = gate.ok && banIp(target.ip, reason, target);
        const why = gate.ok ? (banned ? null : 'target is exempt — review only') : gate.reason;
        logReport({
          kind: reason.startsWith('auto:') ? 'auto-moderation' : 'user-report',
          reporter: socket.peerId, reporterIp: socket.ip, target: target.peerId, targetIp: target.ip,
          reason, note,
          action: banned ? 'banned' : `NOT banned — ${why}`,
        });
        const p = socket.party;
        if (banned) banSocket(target);
        else queueReview({ reason, note, targetIp: target.ip, target: target.peerId, reporterIp: socket.ip, reporter: socket.peerId, verdict: check.verdict || null, why });
        // The reporter leaves the room either way. A throttled ban is our
        // problem, not theirs, and stranding someone with the person they just
        // reported is the one outcome worse than a missed ban.
        send(socket, { type: 'report-ack' });
        if (p && p.session) dissolveSession(p.session, p.session.parties.filter((x) => x.members.length));
        break;
      }
      case 'report-last': {
        const cutoff = Date.now() - REPORT_LAST_GRACE_MS;
        const recent = (socket.lastOpponents || []).filter((o) => o.at >= cutoff);
        // ONE person, named by the picker — this used to ban everyone from the
        // last 30 seconds, so a fast skipper took out innocent bystanders with
        // a single tap. No pick, no action.
        const chosen = recent.find((o) => o.peerId === msg.peerId);
        if (!chosen) { send(socket, { type: 'report-ack', last: true }); break; }
        const reason = String(msg.reason || '').slice(0, 80);
        const note = String(msg.note || '').slice(0, 200);
        const check = confirmedExplicit(msg);
        const gate = check.ban ? mayBan(socket.ip, 1) : { ok: false, reason: check.why };
        const banned = gate.ok && banIp(chosen.ip, reason || 'report-last', null);
        const whyLast = gate.ok ? (banned ? null : 'target is exempt — review only') : gate.reason;
        logReport({
          kind: 'report-last', reporter: socket.peerId, reporterIp: socket.ip, target: chosen.peerId,
          targetIp: chosen.ip, reason, note,
          action: banned ? 'banned' : `NOT banned — ${whyLast}`,
        });
        if (banned) wss.clients.forEach((c) => { if (c.ip === chosen.ip && c.readyState === c.OPEN) banSocket(c); });
        else queueReview({ reason, note, targetIp: chosen.ip, target: chosen.peerId, reporterIp: socket.ip, reporter: socket.peerId, verdict: check.verdict || null, why: whyLast });
        send(socket, { type: 'report-ack', last: true });
        // Only the reported one is spent; the others stay reportable.
        socket.lastOpponents = (socket.lastOpponents || []).filter((o) => o !== chosen);
        break;
      }
    }
  });

  socket.on('close', () => {
    console.log(`Disconnected ${socket.peerId}`);
    if (socket.counted) { releaseConnection(socket.ip); socket.counted = false; }
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
