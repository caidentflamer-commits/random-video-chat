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
- **Host:** Render **Starter ($7/mo) since 2026-08-08** — upgraded from Free.
  **Push to `main` → auto-deploys.** The instance **no longer sleeps**, so the
  first visitor after a quiet spell isn't waiting ~a minute and Stripe webhooks
  don't hit a cold instance. Changing instance type triggers a redeploy, which
  restarts the process and drops any call in progress — don't do it while
  someone's on. This also **removes cold starts as a variable** in any
  intermittent-connection debugging (see Gotchas).
- **Live URL:** `https://olumie.chat` (bought 2026-08-03 via Sav; auto-renew ~$28/yr).
  Render's `https://random-video-chat-azkk.onrender.com` keeps working — both
  resolve, but `olumie.chat` is canonical in the SEO tags.
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
  Payment Link with `client_reference_id=<userId>`. **LIVE MODE — taking real
  money since 2026-08-07.** Premium is $4.99/mo.
- **Durable bans/reports:** written to Supabase when configured (confirmed
  `supabaseConnected: true`).
- **SEO:** meta/OG tags, `robots.txt`, `sitemap.xml` — all now point at
  `https://olumie.chat` (PR #24). **Search Console: `https://olumie.chat`
  verified 2026-08-07** as a URL-prefix property, alongside the older
  `onrender.com` one.
  ⚠ **`<head>` carries TWO `google-site-verification` tags — keep both.** Search
  Console issues one token per property, so removing either un-verifies that
  property. They look like duplicate cruft; they aren't (PR #29).
  A *Domain* property was attempted and abandoned: Google offers a one-click
  Cloudflare flow (the nameservers are Cloudflare's) but there is no Cloudflare
  account to sign into — see the DNS note under Services. URL-prefix is
  sufficient, since `https://olumie.chat/` is the canonical anyway.
- **TURN:** `/ice` serves ICE config from env; **STUN-only today**, TURN plumbing
  ready (see `TURN.md`).
- **Upgrade prompt (PR #32):** tapping a locked gender filter opens a modal stating
  what Premium does, that the free version is unchanged, that cancelling is one tap,
  and the price — checkout only opens from an explicit **Continue**. It previously
  jumped straight to Stripe, so the price was first seen on a payment page. Shown to
  signed-out visitors too; Continue then routes to sign-in. `window.open` must stay
  directly inside the Continue click handler (a user gesture) or mobile popup
  blockers eat it, and `client_reference_id` must keep riding through — the webhook
  maps the payment to a user with it.
- **Manage/cancel subscription:** `POST /portal` verifies the caller's Supabase
  token, looks up their `stripe_customer_id` server-side, and returns a Stripe
  **billing-portal** URL. A "Subscription" button appears in the status bar only
  for signed-in premium users. Self-serve cancellation exists so people cancel
  instead of filing disputes — dispute rate is what gets a high-risk merchant
  terminated. ⚠ Needs the portal **activated once** in Stripe → Settings →
  Billing → **Customer portal** — DONE 2026-08-05 (config `bpc_1U13U9…`, Active,
  cancellation enabled). Failures now name themselves (PR #26): 401 expired
  session, 404 no subscription, 503 not set up, else Stripe's own error code.
- **Support tip button:** hidden unless `SUPPORT_URL` (a constant in index.html) is set.

## Services (see the in-app services console the user has)
GitHub · Render · Supabase · Stripe (**LIVE mode, approved**) · Discord (moderation
feed) · Resend (SMTP for auth emails, `olumie.chat` **verified**) · Google Search
Console · Google Cloud (OAuth client) · **Sav (registrar AND where DNS records are
managed)**.

⚠ **DNS is edited at Sav, not Cloudflare.** A lookup shows Cloudflare nameservers
(`cheryl/logan.ns.cloudflare.com`) because Sav uses Cloudflare as its DNS backend —
there is **no Cloudflare account**. Records live in Sav → Manage DNS Settings →
**Custom DNS Records**. This misled a whole session; don't go looking in Cloudflare.

⚠ **Every DNS record's `Proxy` toggle in Sav must stay OFF**, and so must Sav's
**SSL** and **DDoS Protection** switches. Proxying breaks the
WebSocket signaling and rewrites `x-forwarded-for`, which corrupts the IP bans in
`getClientIp()` — a shared proxy IP could ban unrelated users en masse.

## What it costs (checked 2026-08-03 — re-verify before committing)
**~$7/mo of recurring spend** as of 2026-08-08 (Render Starter), plus the domain
already paid for — `olumie.chat` (~$5 year one, ~$28/yr after). Nothing else is
outstanding to reach "launched properly" on the hosting side. Stripe sits
outside these totals — no monthly fee, it takes a cut per charge. TURN is the
one thing still unbought, and free at this scale (see Next steps).

| Service | Now | At launch | Notes |
|---|---|---|---|
| Render | **$7/mo** | **$7/mo** | **Starter, bought 2026-08-08.** Free tier slept after ~15 min, so the first visitor waited ~1 min and Stripe webhooks hit a cold instance. Same 512 MB RAM as Free; you're paying for it to stay awake, not for size. |
| Supabase | Free | **$0–35/mo** | Free (500 MB, 50k MAU) genuinely covers launch. Pro $25 + custom domain $10 buys only the auth-domain fix below. Free projects pause after ~1 week idle. |
| Stripe | live | **2.9% + 30¢** | Per charge, +0.7% if using Billing. No monthly fee — you pay only when you earn. **Approved 2026-08-07.** |
| Domain `olumie.chat` | **bought** | **~$28/yr** | Sav, registered 2026-08-03. ⚠ `.chat` renews far above its ~$5 signup price — auto-renew is the thing to keep on. |
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
  the built-in email is rate-limited). Supabase **Site URL** must be the live URL
  or links die at localhost.
- ✅ **RESEND DOMAIN VERIFIED (2026-08-07) — magic link now works for everyone.**
  `olumie.chat` is verified in Resend (us-east-1) and Supabase's SMTP sender is
  `noreply@olumie.chat`. This closed a real gap: the previous shared
  `onboarding@resend.dev` sender **only delivered to the Resend account owner**, so
  every other person got "check your inbox" and nothing arrived. Google sign-in
  masked it.
  DNS (added at **Sav**, not Cloudflare — see Services): `resend._domainkey` TXT
  (DKIM), `send` MX → `feedback-smtp.us-east-1.amazonses.com` pri **10**, `send`
  TXT SPF, `_dmarc` TXT. All four confirmed resolving.
  Verified by signing in with the owner's own address and confirming the mail came
  **from `noreply@olumie.chat`**. Not tested: delivery to a non-owner address —
  judged unnecessary, since that restriction is a property of the shared sender and
  no longer applies once a domain is verified. **Resend → Emails is the safety
  net**: a failed real-user link shows there as Bounced/Failed without them
  reporting it.
- ✅ **STRIPE APPROVED & LIVE (2026-08-07).** The high-risk category worry did not
  materialise. Account status shows *"No active tasks"*, payouts are **enabled and
  daily**, no restrictions. Live keys, live Payment Link
  (`buy.stripe.com/28E28t9SV3eq3Me2Hx1oI00`, $4.99/mo) and a live webhook endpoint
  are all configured; the 3 Stripe env vars on Render were swapped to live.
  How to re-check status later: Settings → Business → **Account status** (tasks) and
  **Balances** (payouts). The dashboard home is mostly noise.
- ✅ **LIVE PREMIUM LOOP VERIFIED WITH A REAL CHARGE (2026-08-07).** $5.45 (incl.
  tax) succeeded on a real card → webhook fired → `is_premium = true` and the
  correct **live** `stripe_customer_id` stored. This is the thing test mode could
  never prove, since live uses a different webhook secret.
- ✅ **Premium loop verified in test mode first (2026-08-03)** with card
  `4242 4242 4242 4242`; cancel flipped it back.
- ✅ **`olumie.chat` IS LIVE (2026-08-04).** Sav's DNS (Cloudflare-backed
  nameservers); apex `A → 216.24.57.1` (Render), `www` CNAME → the Render host.
  HTTPS + certificate issued by Render. Canonical/`og:url`/robots/sitemap all
  switched (PR #24). The Render URL still serves, so no dead links.
  Getting here was fiddly: Sav's "coming soon" parking nameservers had to be
  replaced, and Sav's **SSL / DDoS toggles must stay OFF** — they proxy the domain
  and override the A record.
- ✅ **Google consent screen PUBLISHED — "In production" (2026-08-07).** Anyone can
  sign in; the test-user list no longer applies. The "100 user cap" shown on that
  page does **not** bind us — it only applies to apps requesting unapproved
  sensitive/restricted scopes, and ours (`email`/`profile`/`openid`) are all
  non-sensitive.
- ✅ **Self-serve cancellation shipped** (PR #25) + made diagnosable (PR #26).
- ✅ **Subscription/cancel portal CONFIRMED WORKING (2026-08-07).** It failed at
  first with a generic message; PR #26 made failures name themselves and the retry
  reported **`StripeAuthenticationError`** — Stripe was rejecting the API key. The
  live secret key on Render was invalid (Stripe showed `Last used —`, i.e. never
  successfully used). Rotated the key, updated Render, portal opened.
  ⚠ **Why nothing else caught it, and the lesson:** `STRIPE_SECRET_KEY` is used by
  **exactly one** code path — `POST /portal`. The webhook verifies signatures with
  local HMAC (`STRIPE_WEBHOOK_SECRET`, a different value, no API call), and premium
  activation only writes to Supabase. So a completely invalid API key looked
  perfectly healthy: real charges succeeded, `is_premium` flipped, `/config` served
  the live link. **Nothing in this app proves the Stripe API key works except
  opening the portal.** Rotating the key does *not* affect webhook endpoints.
- ⚠ **OPEN: Caiden has a live subscription to his own app** — $4.99/mo, customer
  `cus_V1xVyhI8rlmGlf`, plus a second one bought to retest the portal. Cancel and
  refund from Stripe → Customers unless kept deliberately as a test subscriber.
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

## ACTIVE THREAD: mobile UI rework (started 2026-08-08)

Caiden's current focus. The mobile layout is cluttered and should feel like a
**FaceTime call** instead.

**The measurement that frames it.** On a 375×812 phone, on a video chat app:
- **Video occupies 5% of the screen.** FaceTime is effectively 100%.
- 39 visible blocks stacked on one screen.
- The layout is a `.videorow` (56% of the height) above a `.bottomrow` (38%),
  with the local preview at 18% and a separate `#chatPanel` always present.
- Idle state fills the largest tile with a text panel (`#idlePanel`, 55%) rather
  than with camera.

**Direction.** FaceTime's shape: remote video full-bleed edge to edge; own camera
as a small rounded picture-in-picture in a corner; controls hidden until tap, then
a floating row over the video; no permanent panels, no side-by-side tiles; status
and chat overlaid rather than boxed.

**Constraints that must survive the rework** (all verified working, don't break them):
- Party Mode is a mesh of up to 4, so the layout needs a multi-tile state as well
  as 1-on-1. `#remoteGrid` uses `data-n` for the count.
- The NSFW check samples `els.local` and each remote `<video>`; those elements must
  stay in the DOM and keep playing, not be unmounted when controls hide.
- The age gate, report flow, ring light and Premium/filters modals all overlay the
  same screen. z-index order: ring light 40, modals 50, toast 60, banned 70, warn
  80, age gate 90.
- `render()` in `index.html` is the single source of truth for what's on screen,
  driven by `phase` (`idle` | `searching` | `connected`) plus `peers.size`. Rework
  the layout through it rather than around it.

### Done — stage + floating controls (PR A, 2026-08-08)

All of it is CSS inside the existing `@media (max-width: 720px)` block plus ~40
lines of JS. **Desktop is byte-for-byte unchanged** (verified by measuring the
layout at 1280×800 before/after).

- **The video is the screen.** `.videorow` is `position:absolute; inset:0`;
  `.statusbar` and `.bottomrow` float over it. Layers: PiP-full-bleed 1 ·
  `#remoteGrid` 2 · PiP 6 · scrim 8 · idle copy 9 · controls 10 — all below the
  ring light's 40, so the existing overlay order is untouched.
- **Your camera is the idle backdrop**, then demotes to a corner PiP the moment
  someone arrives. Same element (`#rightTile`), so the swap animates. It's sized
  with `right`/`bottom`/`width`/`height` rather than `inset` **on purpose** —
  `auto` doesn't interpolate, so `inset` would snap instead of animate.
- **Camera is now acquired when the age gate is accepted**, not at Start —
  phones only (`startStageCamera()`); desktop still waits for a gesture.
- **Controls fade out 4.2s into a call** (`body.controls-hidden`), tap the video
  to toggle. Only in `connected` — idle and searching need their button. Nothing
  is ever unmounted, so the NSFW sampler keeps reading every `<video>`.
- **`--dock-h`** is the dock's measured height, set from `render()` (and a
  `ResizeObserver`). The PiP and the idle copy both float directly above it.
  ⚠ If you add anything to the dock, don't hardcode a height — read this.
- `render()` now also sets `body[data-peers]` and toggles `#leftTile.has-remote`
  (was an inline background) — both are load-bearing for the phone CSS.
- Party mesh **stacks** into rows on a phone instead of a 2×2 grid.
- `viewport-fit=cover` + `env(safe-area-inset-*)` padding on both overlays.

**Still open (PR B):** chat is functional but plain — it should become fading
bubbles with a 💬 toggle rather than a always-present log + field. The n=1
report flag should move into the control row. iOS keyboard vs. `100dvh` +
fixed overlays is untested — may need a `visualViewport` listener.

## Next steps

**The launch blockers are all cleared.** Stripe is approved and taking real money,
the domain is live, Google sign-in is published, and the premium loop has been
proven with an actual charge. What's left is cleanup and a judgement call about
whether to promote it.

1. **Retry the Subscription button** after PR #26 deployed, and read the message —
   it now identifies the cause instead of saying "try again". See Current status.
2. **Cancel Caiden's own subscription + refund the $5.45** (renews Sep 7).
3. ✅ **Render Starter ($7/mo) — DONE 2026-08-08.** Service → Settings → General →
   Instance Type. Verified after the redeploy: 200s in ~100–450 ms, `/ice` and
   `/config` still serving, env vars survived the instance change.
   **TURN is the remaining pre-promotion item.** Cloudflare Realtime TURN, free
   to 1,000 GB/mo, set `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` in the
   same Environment tab. `/ice` still returns STUN-only until then. Include a
   `turns:` entry on 443 — on a locked-down work network that's often the only
   one that gets through. Why it's worth doing before any traffic: a relay
   failure burns *both* users in a match, and nobody reports it, they just
   leave. See `TURN.md`.
4. **Small tail, none blocking:** in Search Console, submit `sitemap.xml` and
   **Request Indexing** on the homepage (the property is verified; these are what
   shorten the first crawl from weeks to days) · point Stripe's **business URL** at
   `olumie.chat` · clear Stripe's **phone verification** prompt.
   (Resend domain and Search Console verification — DONE, see status.)
   Expectation-setting on SEO: a new domain with no backlinks will not rank for
   "random video chat" or "omegle alternative" — those are contested by sites with
   years of history. It will rank for "olumie", which nobody searches yet. Growth
   for this category comes from TikTok/Reddit/Discord, where Party Mode is the
   actually-shareable idea. Treat search as a slow compound, not a launch channel.
5. **Before promoting anywhere — moderation is now an ongoing commitment.** The
   automated stack is a filter, not a backstop; the Discord report feed needs a
   human, and that human is Caiden. In this category that includes the possibility
   of illegal content involving minors, which carries real legal reporting
   obligations. Decide how a 2am report gets handled *before* it happens.
6. **Optional, ~$35/mo — the auth-domain polish.** Google's account picker
   shows the redirect target's domain, so today it reads *"to continue to
   yyterkkuqceodisnhehu.supabase.co"* — a random ref that looks like phishing to a
   consumer. A Supabase custom domain moves auth to e.g. `auth.olumie.chat` and the
   prompt names that instead. It's a paid add-on ($10/mo) **and needs Pro ($25/mo)**,
   so ~$35/mo total. Nothing in the Google consent screen config changes that line —
   app name/logo only affect the *permission* screen after account choice. The
   redirect URI must change at the same moment as the domain or sign-in breaks, so
   these are one coordinated change, not two. Deferred deliberately: worth
   revisiting once there's evidence real users drop off at sign-in, not before.
7. **Deferred:** ad-free (needs an ad system + a category-friendly ad network —
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
- Git identity is **not set globally**. Set it `--local` in this repo to match
  history: `Caiden <caidentflamer@gmail.com>`.
- The repo lives at `C:\Users\caide\Documents\random-video-chat`. Sessions often
  open with the working directory set to an **unrelated project**, so `HANDOFF.md`
  read from the cwd may be a different app entirely.

## Gotchas that have already cost time — read before repeating them
- **"Matched but no audio or video" is still UNEXPLAINED — don't inherit a
  wrong answer for it.** Reported 2026-08-08 (Caiden at work ↔ sister at home,
  both on phones): matched, text chat worked, no media; an immediate retry from
  the same two networks worked. A first pass blamed a race in `onSignal` —
  one async call per WebSocket message, so `await setRemoteDescription` yielded
  and a candidate behind it hit `addIceCandidate` with no remote description,
  rejecting into a bare `catch {}`. **That diagnosis was wrong, and the test
  that disproved it is worth knowing:** replaying the exact burst (offer + 8
  candidates delivered in one synchronous tick) through the *old* handler
  dropped **zero** candidates and connected fine. `RTCPeerConnection` has its
  own **internal operations queue** — `setRemoteDescription` and
  `addIceCandidate` are queued operations that run in FIFO order, so a candidate
  handed over after `setRemoteDescription` was *initiated* waits for it no
  matter how the JS interleaves. Don't re-derive that the hard way.
  The two live hypotheses, in order:
  1. **NAT / no TURN.** Still unconfigured. A work network is the textbook
     failing pair. Note that "it worked on retry" is **weak** evidence against
     NAT — candidate gathering and which pairing survives are nondeterministic,
     so a marginal network really is intermittent.
  2. **Blocked autoplay** on the remote `<video>` — identical symptom, but with
     a perfectly healthy ICE connection. Hardened since (explicit `play()`,
     rejection caught, retried on tap), so this should now announce itself.
  **How to tell them apart:** ICE failure now shows a message (skip / friend
  tile / "probably a firewall"). No message *and* no picture ⇒ not ICE.
- **Cold starts are no longer a variable.** Render's free-tier sleep changed
  signal *timing*, not just load time, which made it a tempting explanation for
  anything intermittent — it was investigated and cleared above. Since the
  Starter upgrade (2026-08-08) the instance doesn't sleep at all, so if
  "matched but no media" recurs, cold start is ruled out by construction.
- **DNS records are edited at Sav, not Cloudflare.** A lookup returns Cloudflare
  nameservers because Sav uses Cloudflare as its backend. There is no Cloudflare
  account. Records: Sav → Manage DNS Settings → **Custom DNS Records**.
- **Sav's `Proxy` toggle, `SSL` and `DDoS Protection` must stay OFF.** They proxy
  the domain and silently **override the A record**, which looks exactly like a
  propagation delay. They also break the WebSocket and rewrite `x-forwarded-for`,
  corrupting the IP bans in `getClientIp()`.
- **Fresh domains sit on parking nameservers.** Sav ships `ns*-coming-soon.sav.com`;
  nothing resolves until DNS mode is switched to Custom DNS Records.
- **`<head>` has TWO `google-site-verification` tags on purpose** — one per Search
  Console property. Deleting either un-verifies that property.
- **A broken `STRIPE_SECRET_KEY` is invisible.** It's used by one path only
  (`POST /portal`). Webhooks verify by local HMAC and premium activation writes to
  Supabase, so payments can work perfectly with a dead API key. If you ever rotate
  or re-paste it, **open the Subscription button to confirm it** — nothing else
  will tell you.
- **The price is written down in two places that nothing keeps in sync.**
  `PREMIUM_PRICE` in `public/index.html` (shown in the upgrade prompt) and the real
  price on the Stripe Payment Link. **Change the price in Stripe → change it here in
  the same sitting.** A prompt advertising one price while checkout charges another
  is exactly the "I didn't agree to that" that becomes a chargeback, and dispute
  rate is what gets a high-risk merchant terminated.
- **Test-mode and live-mode Stripe objects are separate.** Payment Links, webhook
  endpoints, signing secrets and the customer portal config all have to be created
  again in live mode; only products/prices copy over.
- **Verifying the premium loop in test mode does not verify it live** — the webhook
  secret differs. It has since been confirmed live with a real charge.
- **PowerShell + `git`/`gh`:** never inline text containing quotes or newlines as an
  argument; PS 5.1 re-splits it. Write the text to a file and use `git commit -F`
  and `gh pr create --body-file`. Also, `git push` writing progress to stderr shows
  up as a PowerShell `NativeCommandError` — that is **not** a failure.
