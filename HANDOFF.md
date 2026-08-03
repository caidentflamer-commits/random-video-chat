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
Resend (SMTP for auth emails) · Google Search Console · Google Cloud (OAuth client).

## What it costs (checked 2026-08-03 — re-verify before committing)
**Everything is on a free tier today: $0/mo.** At launch: **~$10/mo minimum**,
**~$45/mo polished**. Stripe sits outside those totals — no monthly fee, it takes
a cut per charge.

| Service | Now | At launch | Notes |
|---|---|---|---|
| Render | Free | **$7/mo** | Starter. Effectively mandatory — free tier sleeps after ~15 min, so the first visitor waits ~1 min and Stripe webhooks hit a cold instance. |
| Supabase | Free | **$0–35/mo** | Free (500 MB, 50k MAU) genuinely covers launch. Pro $25 + custom domain $10 buys only the auth-domain fix below. Free projects pause after ~1 week idle. |
| Stripe | $0 | **2.9% + 30¢** | Per charge, +0.7% if using Billing. No monthly fee — you pay only when you earn. |
| Domain `olumie.chat` | — | **~$38/yr** | ⚠ `.chat` renews far above its signup price (~$6 first year). Compare **renewal** columns, not headline prices. |
| TURN relay | — | Free <1 TB | Cloudflare: 1,000 GB/mo free, then $0.05/GB. Likely stays free at this scale. |
| Resend · Google Cloud · GitHub · Search Console · Discord | Free | **Free** | No paid tier needed. Resend free = 3,000 emails/mo (100/day), 1 domain — domain verification is included. |

Free-and-staying-free dependencies: NSFWJS, TensorFlow.js, jsDelivr, Google Fonts,
Google STUN.

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
- ✅ **Google sign-in LIVE (2026-08-03, PR #21).** Provider enabled on the Supabase
  project; the button auto-unhides via `/auth/v1/settings` (no redeploy needed to
  turn it on/off). Handshake verified as far as Google's account picker. Magic link
  remains as the fallback. Why it was added: magic link costs an email round trip
  on every new browser, and iOS Safari evicts the stored session after ~7 days —
  that round trip sat inside the upgrade funnel.
- ✅ **REAL-DEVICE TESTING PASSED (2026-08-03)** — all four cases: solo 1-on-1
  across **different networks** (Wi-Fi ↔ cellular), Party Mode (4-char code join,
  "Find people" together, Next keeping friends together), and mobile browsers.
  **Video connects on STUN alone — no TURN needed.** So `TURN_*` stays unset and
  the relay costs nothing for now.
  ⚠ Caveat: this is one pair of networks, not proof. NAT behaviour varies by
  carrier and router, and a minority of real-world pairs typically still need a
  relay. The plumbing is already built (`/ice`, `TURN.md`) — if users report a
  black remote tile while chat still works, that's the signal to switch it on.
  Cloudflare's first 1,000 GB/mo is free, so enabling it is cheap insurance.
- ✅ **The webhook now fails loudly** (PR #20). It used to answer 200 even when it
  wrote nothing: `.update().eq('id', …)` matches zero rows on a missing `profiles`
  row and reports success, and DB errors were swallowed by a catch that still
  returned 200 (mislabelled `bad signature`). Now: upsert; **400** = bad signature
  (permanent), **500** = handler failure (Stripe retries, shows red). Sign-out also
  clears `socket.isPremium` server-side, which previously survived until reconnect.

## Next steps
1. **Finish Google sign-in.** Provider is ENABLED and the button is live
   (`external.google: true`); the OAuth handshake reaches Google's account picker,
   so the Client ID + redirect URI are correct. Remaining: (a) add your own account
   under **Audience → Test users** or Google blocks your own sign-in while the app
   is in Testing, (b) **Publish app** before real users — the test-user list caps at
   100. Publishing with only `email`/`profile`/`openid` (all non-sensitive) does
   **not** trigger Google's verification review.
2. **Start Stripe business verification NOW** — it is the long pole and the only
   item that can block launch outright. ⚠ High-risk category: it may be declined,
   and the fallback is a high-risk processor charging well above 2.9%. Approval
   takes days-to-weeks, so start it and do everything below while waiting. No
   amount of money speeds this up.
3. **Go live** (once verification clears): a **live** Payment Link + live keys,
   swap the 3 Stripe env vars, verify a Resend domain for real auth emails, and
   pay for **Render Starter ($7/mo)** so the app stops sleeping — a cold start on
   a video-chat app loses the visitor, and it delays Stripe webhooks.
4. **Custom domain:** `olumie.chat` is available (`.com` is taken/parked). On
   purchase: Render custom domain + update the URL in `robots.txt`, `sitemap.xml`,
   `<link rel=canonical>`, `og:url`, `SUPABASE_URL`/redirect settings, and add a
   new Search Console property.
   **Do the Supabase custom domain in the same sitting.** Google's account picker
   shows the redirect target's domain, so today it reads *"to continue to
   yyterkkuqceodisnhehu.supabase.co"* — a random ref that looks like phishing to a
   consumer. A Supabase custom domain moves auth to e.g. `auth.olumie.chat` and the
   prompt names that instead. It's a paid add-on ($10/mo) **and needs Pro ($25/mo)**,
   so ~$35/mo total. Nothing in the Google consent screen config changes that line —
   app name/logo only affect the *permission* screen after account choice. The
   redirect URI must change at the same moment as the domain or sign-in breaks, so
   these are one coordinated change, not two. Treat it as a launch-blocker for the
   paid tier, not cosmetic — people bounce off sketchy Google prompts.
5. **Deferred:** ad-free (needs an ad system + a category-friendly ad network —
   mainstream networks reject this category, like payment processors), priority
   matching, more Premium perks. **TURN is deferred on evidence now, not
   assumption** — real-device testing showed STUN is enough (see Current status).

## Working conventions used this far
- Change on a branch → PR → merge to `main` → Render deploys. (A few tiny fixes
  went straight to `main`.)
- Verify the live server with `curl`: `/config`, `/ice`, `POST /stripe/webhook`.
- Local dev on Windows: PowerShell with an inline PATH refresh for `node`; run
  `node server.js`; the app runs fully anonymous with no env (safe to develop).
- Everything Supabase/Stripe/TURN-related is **inert without its env vars**, so
  half-built features deploy safely.
