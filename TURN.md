# TURN setup

WebRTC tries a **direct** peer-to-peer connection first (helped by STUN). When
both peers sit behind strict/symmetric NATs — common on mobile data and some
locked-down Wi-Fi — the direct path fails and media must be **relayed** through a
**TURN** server. This matters more in Party Mode, where a room of 3–4 is a full
mesh (every pair needs its own connection).

The app is already wired for TURN. You just add credentials as **environment
variables** on Render — nothing secret goes in the repo. With nothing set, the
app falls back to STUN-only (exactly how it runs today).

## How it works

- The server exposes `GET /ice`, returning `{ iceServers: [...] }` (always STUN,
  plus TURN when configured). For the HMAC scheme it mints **fresh short-lived
  credentials on every request**, so nothing long-lived is exposed to browsers.
- The client fetches `/ice` at load and again before each session, and uses it
  for every `RTCPeerConnection`.

## Option A — Cloudflare Realtime (built in, recommended)

Cloudflare does **not** hand out a fixed username/password. It mints
**short-lived** credentials from an API, so there is nothing static to paste —
a snapshot would work until it expired and then fail silently, which looks
exactly like the NAT problem TURN exists to fix. The server therefore mints
them itself; you only supply the key.

1. Cloudflare dashboard → **Realtime** → **TURN** → create a TURN key.
2. Copy the **TURN Key ID** and the **TURN Key API Token**.
3. On Render → Environment:

```
TURN_KEY_ID=<the key id>
TURN_KEY_API_TOKEN=<the api token>
TURN_TTL=86400        # optional, seconds; default 24h, minimum 600
```

Nothing else is needed — no `TURN_URLS`. Cloudflare returns its own endpoints,
including **TLS on 443**, which is the one that gets through locked-down
corporate Wi-Fi.

How it behaves: credentials are minted at boot and cached, re-minted at **half
the TTL** so a session never starts on a credential about to expire, and shared
by all callers (one in-flight request, not one per visitor). If Cloudflare is
unreachable the server logs `TURN: Cloudflare credential fetch failed` and
serves STUN-only rather than failing `/ice` — the failure is not cached, so it
recovers on the next request.

**Cost (checked 2026-08-09):** **1,000 GB/month free**, then **$0.05/GB**. The
free allowance applies to standalone TURN, not just TURN-with-their-SFU, and is
shared across both if you ever use both. **Only egress is billed** — traffic
from clients *into* Cloudflare is free.

What that buys here: a relayed 1-on-1 is two streams (each peer receives the
other's), so at roughly 1 Mbit/s per stream it's about **0.9 GB per hour of
relayed conversation** — call it **~1,100 hours/month free**. Since only a
minority of pairs need a relay at all, total talk time before you pay is several
times that. Past the allowance it's roughly **4–5¢ per relayed hour**.
⚠ Party Mode is a full mesh: 4 people is 3 connections each, so a relayed party
call burns bandwidth several times faster than a 1-on-1.
The bitrate here is an assumption, not a measurement — `mediaFailRate` on
`/admin/stats` is what will tell you the real relay share.

## Option B — Other managed TURN

Pick a provider and create a TURN credential. Common choices with free/cheap
tiers: **Cloudflare Realtime (TURN)**, **Metered / Open Relay**, **Twilio Network
Traversal**, **Xirsys**. You do the signup (I can't create accounts).

Most managed providers give you **static** credentials. Set these on Render
(Dashboard → your service → **Environment**):

```
TURN_URLS=turn:relay.example.com:3478,turns:relay.example.com:5349
TURN_USERNAME=<the username they gave you>
TURN_CREDENTIAL=<the password/credential they gave you>
```

`TURN_URLS` is a comma-separated list. Include a `turns:` (TLS, port 443/5349)
entry too — it punches through the most restrictive firewalls.

> Some providers (e.g. Twilio) issue **time-limited** creds via their own API.
> Pasting a current username/credential into the static vars above works until
> it expires — and then video fails silently. **Cloudflare is integrated
> properly** (Option A); for another provider, say which and I'll add it the
> same way.

## Option C — Self-hosted coturn (HMAC secret)

Run [coturn](https://github.com/coturn/coturn) on a small VM (a $5/mo box is
plenty) with a shared-secret auth. In `turnserver.conf`:

```
use-auth-secret
static-auth-secret=<a long random string>
realm=your-domain.com
# open UDP/TCP 3478 and 5349 (TLS); a public IP is required
```

Then on Render set:

```
TURN_URLS=turn:your-domain.com:3478,turns:your-domain.com:5349
TURN_SECRET=<the same static-auth-secret>
TURN_TTL=43200        # optional; credential lifetime in seconds (default 12h)
```

The server generates `username = <expiry>:olumie` and
`credential = base64(HMAC-SHA1(TURN_SECRET, username))` per request — the
standard coturn REST scheme.

## Verify it's working

1. After setting the env vars, redeploy. Open `https://<your-app>/ice` — you
   should see a `turn:`/`turns:` entry with a `username` and `credential`.
2. In the app, open the browser console during a call and run:
   ```js
   // logs candidate types; "relay" means TURN is being used
   ```
   Or use https://icetest.info / Trickle ICE with your TURN URL + credentials to
   confirm a **relay** candidate appears.
3. Best real test: two devices on **different** networks (e.g. one on home Wi-Fi,
   one on mobile data) — with TURN they connect; without it they often won't.

## Notes

- TURN **relays media**, so it uses real bandwidth (and metered providers bill
  for it). Direct connections are still preferred automatically; TURN is only the
  fallback.
- No env vars set → STUN-only, no cost, current behavior. Safe to deploy as-is.
