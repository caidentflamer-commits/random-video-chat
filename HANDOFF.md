# Olumie — project handoff

Snapshot of where the app is so a fresh session can continue. Read this first,
then the topic docs: `DEPLOY.md`, `MODERATION.md`, `SUPABASE.md`, `TURN.md`,
`SEARCH_CONSOLE.md`. **The code is the source of truth** — skim `server.js` and
`public/index.html` before changing anything.

## What it is
**Olumie** — a random-stranger video chat (OmeTV / Monkey style), 18+, moderated.
Formerly "Random Video Chat" / "Openline". Free + solo, plus **Party Mode** (meet
people together with a friend — or with a stranger you both chose to keep, via
"Stay together"). Monetized by a **Premium** subscription.

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
- **Stay together (2026-08-09):** mid-call, either person in a 1-on-1 can offer to
  keep the other; on mutual accept the two solo parties **merge** into a party of
  2 — the same shape join-by-code produces, so nothing downstream changed. The
  existing WebRTC connection is **relabelled, not rebuilt**, so the conversation
  doesn't drop. Offered only when both sides are solo (that's what keeps the
  group at 2). Strictly mutual: an invite changes nothing until accepted, and
  dismissing the prompt counts as a decline so nobody waits on a closed dialog.
- **Matching filters:** interests, region, language (`compatible()` on the server).
- **Gender filter (Premium):** everyone declares gender at the age gate; a
  "Meet: anyone/women/men" preference is **Premium-gated** (enforced server-side —
  non-premium `genderPref` is forced to `any`).
- **Moderation:** age/18+ gate (also collects gender), NSFW self-camera check +
  NSFW **remote-camera** auto-skip/report (nsfwjs), chat **link filter**, IP bans,
  report modal. Fail-safe (off if the model can't load).
  ⚠ **No one is exempt from the remote check, friends included, and every tile
  is reportable** (changed 2026-08-09). Friends used to be skipped, which meant
  swapping a 4-char code — or teaming up mid-call — turned the scanner off for
  both of you. `friend` is a routing flag, not a trust signal. See `MODERATION.md`.
- **Report audit trail:** structured logs + `GET /admin/reports?key=ADMIN_KEY` +
  a **Discord webhook** (`REPORT_WEBHOOK_URL`) — working. Durable in Supabase.
- **Accounts:** Supabase sign-in — **Google OAuth** (one tap) + **magic link**
  (fallback); server verifies tokens via `supabase.auth.getUser()`. `profiles`
  table (`is_premium`, `stripe_customer_id`). The Google button is hidden until
  the provider is enabled on the project (checked via `/auth/v1/settings`).
- **Subscriptions:** `/stripe/webhook` (signature-verified) flips
  `profiles.is_premium` on subscribe / off on cancel; it fails loudly — **400**
  = bad signature (permanent), **500** = handler failure (Stripe retries).
  Upgrade opens the Stripe Payment Link with `client_reference_id=<userId>`.
  **LIVE MODE — taking real money since 2026-08-07.** Premium is $4.99/mo.
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
- **Analytics (2026-08-09):** first-party, aggregate-only counters — no cookies, no
  third party, no per-visitor records, so **no consent banner** and the privacy
  policy stays short. Most of it the server already knew (matches, skips, reports);
  the client reports only what happens in the browser (`gate`, `mediaOk`,
  `mediaFail`, `playBlocked`) via a `stat` message on the existing socket, against
  a fixed whitelist.
  **Read it at `GET /admin/stats?key=ADMIN_KEY`** — a rendered page (funnel,
  cards, and a banded verdict on the failure rate), or `&format=json` for curl.
  Same gate as `/admin/reports`. `ADMIN_KEY` **is set on Render** (2026-08-09).
  Without that key you still get an **hourly `STATS {...}` rollup in the Render
  logs**, which is also the only history: the counters live in memory and reset on
  every deploy.
  Derived rates matter more than the raw counts: `mediaFailRate` is **the
  relay-failure rate — the evidence for or against needing TURN**. Also
  `startRate` (visited → pressed Start), `matchRate` (approximate; over-reports
  once Party Mode is in use, since a session can hold 3–4 people) and `teamUpRate`.
  **`people` / `returning`** count **unique browsers**, via a random id the
  client keeps in `localStorage` (`olumie_vid`) and POSTs to `/visit` on page
  load. POST, not a query string, so the id never lands in an access log or a
  Referer. It's a beacon rather than a socket message **on purpose** — the
  socket only opens when someone presses Start, so a socket-based count would
  miss everyone who bounced. No localStorage (private mode) ⇒ not counted; there
  is deliberately no fingerprinting fallback.
  ⚠ Read them precisely: `visits` = **page loads** (a reload counts again);
  `people` = **browsers, not humans** (one person on a phone and a laptop is
  two, two people sharing a laptop are one); `returning` = repeat visits **since
  the last deploy**, since `seenVisitors` is in memory. The id set is capped at
  50k and stops accepting new ids at the cap rather than evicting — eviction
  would silently re-count evicted browsers as new people.

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
Not set: `ADMIN_KEY` (enables **both** /admin/reports and /admin/stats — worth
setting, it's just a string you choose), `TURN_*` (relay).
(`SUPPORT_URL` is **not** an env var — it's a constant at the top of
`index.html`; the server never reads it.)
The server accepts either the new (`SUPABASE_PUBLISHABLE_KEY`/`SECRET_KEY`) or
classic (`ANON_KEY`/`SERVICE_KEY`) names.

## Current status

**Everything a launch needs is live and verified** — details of each feature are
in "What's built & live"; the debugging that got here is distilled into Gotchas.
What still matters operationally:

- **Stripe: live mode, approved 2026-08-07**, premium loop proven with a real
  charge (test mode can't prove live — different webhook secret). Payment Link
  `buy.stripe.com/28E28t9SV3eq3Me2Hx1oI00`, $4.99/mo. To re-check account
  health: Settings → Business → **Account status** + **Balances**; the
  dashboard home is mostly noise.
- **Auth: Google sign-in live** (consent screen "In production" — the "100 user
  cap" shown there does **not** bind us; it only applies to unapproved
  sensitive scopes). **Magic link via Resend SMTP**, sender
  `noreply@olumie.chat`, domain verified. ⚠ Supabase **Site URL** must stay the
  live URL or links die at localhost. **Resend → Emails is the safety net** — a
  failed real-user link shows there as Bounced/Failed without them reporting it.
- **`olumie.chat` live since 2026-08-04** (Render HTTPS; the onrender.com URL
  still serves, so no dead links). DNS rules live in Services/Gotchas.
- **Real-device testing passed 2026-08-03 on STUN alone** — solo across
  Wi-Fi ↔ cellular, Party Mode, mobile browsers. ⚠ One pair of networks, not
  proof: a minority of real-world pairs need a relay. TURN plumbing is built
  (`/ice`, `TURN.md`); a black remote tile while chat works is the signal —
  **and it may already have fired** (2026-08-08 no-media incident, cause still
  open, see Gotchas). Connection failures now announce themselves in-app.

## ACTIVE THREAD: mobile UI rework — PR A SHIPPED, PR B open

The mobile layout was cluttered and now reads as a **FaceTime call** (PR A,
merged 2026-08-08 — see "Done" below). Remaining: **PR B** (chat as fading
bubbles behind a toggle, n=1 report flag into the control row, iOS keyboard
check on a real device).

**The before-baseline (2026-08-08), kept for contrast.** On a 375×812 phone:
- **Video occupies 5% of the screen.** FaceTime is effectively 100%.
- 39 visible blocks stacked on one screen.
- The layout is a `.videorow` (56% of the height) above a `.bottomrow` (38%),
  with the local preview at 18% and a separate `#chatPanel` always present.
- Idle state fills the largest tile with a text panel (`#idlePanel`, 55%) rather
  than with camera.

**Direction (now built).** FaceTime's shape: remote video full-bleed edge to edge; own camera
as a small rounded picture-in-picture in a corner; controls hidden until tap, then
a floating row over the video; no permanent panels, no side-by-side tiles; status
and chat overlaid rather than boxed.

**Constraints that must survive the rework** (all held through PR A — re-verify
anything PR B touches):
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

1. **TURN — the remaining pre-promotion item.** Cloudflare Realtime TURN, free
   to 1,000 GB/mo: set `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` on
   Render (Environment tab). `/ice` returns STUN-only until then. Include a
   `turns:` entry on 443 — on a locked-down work network that's often the only
   one that gets through. Why before any traffic: a relay failure burns *both*
   users in a match, and nobody reports it, they just leave. See `TURN.md`.
2. **Small tail, none blocking:** in Search Console, submit `sitemap.xml` and
   **Request Indexing** on the homepage (the property is verified; these are what
   shorten the first crawl from weeks to days) · point Stripe's **business URL** at
   `olumie.chat` · clear Stripe's **phone verification** prompt.
   (Resend domain and Search Console verification — both already DONE.)
   Expectation-setting on SEO: a new domain with no backlinks will not rank for
   "random video chat" or "omegle alternative" — those are contested by sites with
   years of history. It will rank for "olumie", which nobody searches yet. Growth
   for this category comes from TikTok/Reddit/Discord, where Party Mode is the
   actually-shareable idea. Treat search as a slow compound, not a launch channel.
3. **Before promoting anywhere — moderation is now an ongoing commitment.** The
   automated stack is a filter, not a backstop; the Discord report feed needs a
   human, and that human is Caiden. In this category that includes the possibility
   of illegal content involving minors, which carries real legal reporting
   obligations. Decide how a 2am report gets handled *before* it happens.
4. **Optional, ~$35/mo — the auth-domain polish.** Google's account picker
   shows the redirect target's domain, so today it reads *"to continue to
   yyterkkuqceodisnhehu.supabase.co"* — a random ref that looks like phishing to a
   consumer. A Supabase custom domain moves auth to e.g. `auth.olumie.chat` and the
   prompt names that instead. It's a paid add-on ($10/mo) **and needs Pro ($25/mo)**,
   so ~$35/mo total. Nothing in the Google consent screen config changes that line —
   app name/logo only affect the *permission* screen after account choice. The
   redirect URI must change at the same moment as the domain or sign-in breaks, so
   these are one coordinated change, not two. Deferred deliberately: worth
   revisiting once there's evidence real users drop off at sign-in, not before.
5. **Deferred:** ad-free (needs an ad system + a category-friendly ad network —
   mainstream networks reject this category, like payment processors), priority
   matching, more Premium perks. **TURN is no longer in this list** — the
   2026-08-08 matched-but-no-media incident (cause still open, NAT is the
   leading hypothesis) promoted it to item 1.

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
