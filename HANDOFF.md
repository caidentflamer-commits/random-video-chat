# Olumie — project handoff

Snapshot of where the app is so a fresh session can continue. Read this first,
then the topic docs: `DEPLOY.md`, `MODERATION.md`, `SUPABASE.md`, `TURN.md`,
`SEARCH_CONSOLE.md`. **The code is the source of truth** — skim `server.js` and
`public/index.html` before changing anything.

## What it is
**Olumie** — a random-stranger video chat (OmeTV / Monkey style), 18+, moderated.
Formerly "Random Video Chat" / "Openline". Free + solo, plus **Party Mode** (meet
people together with a friend). Monetized by a **Premium** subscription.

## Stack & deploy
- **Front end:** `public/index.html` — one file, vanilla HTML/CSS/JS, **no build step**.
- **Back end:** `server.js` — Node HTTP server (serves `public/`) + `ws` WebSocket
  server for signaling/matchmaking/moderation. Deps: `ws`, `@supabase/supabase-js`, `stripe`.
- **Host:** Render free tier. **Push to `main` → auto-deploys.** Free tier **sleeps
  after ~15 min idle** (first hit / webhook after idle is delayed; Stripe retries).
- **Live URL:** `https://random-video-chat-azkk.onrender.com`
- **Repo:** `github.com/caidentflamer-commits/random-video-chat`
- **Design:** Clarity design system (dark "stage"), `public/clarity.css`.

## What's built & live
- **Video chat:** WebRTC 1-on-1 **and Party Mode** — rooms + full mesh (≤4), STUN-only.
  Create/join a party by 4-char code, "Find people" together, Next keeps friends
  together (server room model; peer-addressed signaling; re-match cooldown).
- **Matching filters:** interests, region, language (`compatible()` on the server).
- **Gender filter (Premium):** everyone declares gender at the age gate; a
  "Meet: anyone/women/men" preference is **Premium-gated** (enforced server-side —
  non-premium `genderPref` is forced to `any`).
- **Moderation:** age/18+ gate (also collects gender), NSFW self-camera check +
  NSFW **remote-camera** auto-skip/report (nsfwjs), chat **link filter**, IP bans,
  report modal. Fail-safe (off if the model can't load).
- **Report audit trail:** structured logs + `GET /admin/reports?key=ADMIN_KEY` +
  a **Discord webhook** (`REPORT_WEBHOOK_URL`) — working. Durable in Supabase.
- **Accounts:** Supabase sign-in — **Google OAuth** (one tap) + **magic link**
  (fallback); server verifies tokens via `supabase.auth.getUser()`. `profiles`
  table (`is_premium`, `stripe_customer_id`). The Google button is hidden until
  the provider is enabled on the project (checked via `/auth/v1/settings`).
- **Subscriptions:** `/stripe/webhook` (signature-verified) flips
  `profiles.is_premium` on subscribe / off on cancel. Upgrade opens the Stripe
  Payment Link with `client_reference_id=<userId>`. **Test mode, verified wired.**
- **Durable bans/reports:** written to Supabase when configured (confirmed
  `supabaseConnected: true`).
- **SEO:** meta/OG tags, `robots.txt`, `sitemap.xml`, **Google Search Console
  verified** (tag in `<head>` — don't remove).
- **TURN:** `/ice` serves ICE config from env; **STUN-only today**, TURN plumbing
  ready (see `TURN.md`).
- **Support tip button:** hidden unless `SUPPORT_URL` (a constant in index.html) is set.

## Services (see the in-app services console the user has)
GitHub · Render · Supabase · Stripe (**test mode**) · Discord (moderation feed) ·
Resend (SMTP for auth emails) · Google Search Console.

## Env vars on Render (config is read from env; app is inert without it)
Set: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`,
`SUPABASE_JWKS_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PAYMENT_LINK`, `REPORT_WEBHOOK_URL`.
Not set: `ADMIN_KEY` (enables /admin/reports), `TURN_*` (relay), `SUPPORT_URL`.
The server accepts either the new (`SUPABASE_PUBLISHABLE_KEY`/`SECRET_KEY`) or
classic (`ANON_KEY`/`SERVICE_KEY`) names.

## Current status
- ✅ Durable bans/reports + Discord feed working.
- ✅ **Magic-link sign-in works** (after switching Supabase to **Resend SMTP** —
  the built-in email is rate-limited). Supabase **Site URL** must be the Render
  URL or links die at localhost. Resend's shared `onboarding@resend.dev` sender
  only delivers to the Resend-account email until a domain is verified.
- ✅ Stripe webhook + premium link wired in **test mode** (`/config` serves
  `premiumUrl`; webhook returns 400 to unsigned POSTs = verifying signatures).
- ✅ **Premium loop VERIFIED end-to-end (2026-08-03):** subscribe with test card
  `4242 4242 4242 4242` → `profiles.is_premium = true` → gender filter unlocks →
  cancel flips it back. `stripe_customer_id` confirmed present on the live table.
- ✅ **The webhook now fails loudly** (PR #20). It used to answer 200 even when it
  wrote nothing: `.update().eq('id', …)` matches zero rows on a missing `profiles`
  row and reports success, and DB errors were swallowed by a catch that still
  returned 200 (mislabelled `bad signature`). Now: upsert; **400** = bad signature
  (permanent), **500** = handler failure (Stripe retries, shows red). Sign-out also
  clears `socket.isPremium` server-side, which previously survived until reconnect.

## Next steps
1. **Enable Google OAuth** in the Supabase dashboard — the code is already live,
   the button unhides itself once the provider is on. Steps in `SUPABASE.md`.
   (Google Cloud OAuth client → paste ID/secret into Supabase → reload. No deploy.)
2. **Real-device testing** (2+ people, different networks) — party mode + whether
   cross-network video connects without TURN (that's the signal to enable TURN).
3. **Go live:** Stripe business verification (⚠ high-risk category — may be
   declined; fallback = a high-risk processor), then a **live** Payment Link +
   live keys, and swap the 3 Stripe env vars. Verify a Resend domain for real
   auth emails.
4. **Custom domain:** `olumie.chat` is available (`.com` is taken/parked). On
   purchase: Render custom domain + update the URL in `robots.txt`, `sitemap.xml`,
   `<link rel=canonical>`, `og:url`, `SUPABASE_URL`/redirect settings, and add a
   new Search Console property.
5. **Deferred:** ad-free (needs an ad system + a category-friendly ad network —
   mainstream networks reject this category, like payment processors), a TURN
   server, priority matching, more Premium perks.

## Working conventions used this far
- Change on a branch → PR → merge to `main` → Render deploys. (A few tiny fixes
  went straight to `main`.)
- Verify the live server with `curl`: `/config`, `/ice`, `POST /stripe/webhook`.
- Local dev on Windows: PowerShell with an inline PATH refresh for `node`; run
  `node server.js`; the app runs fully anonymous with no env (safe to develop).
- Everything Supabase/Stripe/TURN-related is **inert without its env vars**, so
  half-built features deploy safely.
