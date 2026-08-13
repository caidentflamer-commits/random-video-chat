# Olumie — marketing plan

Steering doc for growth. Companion to `HANDOFF.md` (read that first for what's
built). Written 2026-08-10, reworked same day: hype-driven, not scheduled.

## The one constraint that shapes everything: liquidity

Olumie is a marketplace of attention — a visitor only has a good experience if
someone else is online *at that exact moment*. The analytics already encode the
failure mode: after 45s queued with nobody available, the spinner honestly says
it's quiet. **Marketing that trickles visitors onto an empty network converts
0% and burns them forever** (a "quiet" first visit is worse than no visit —
they never come back, and `startRate` looks fine while `matchRate` dies).

So traffic must be **concentrated into windows** — but that's a *backstage*
fact, never the pitch. Young adults don't put a website's weekly event in
their calendar; they follow hype. The audience-facing experience is always
**"this is popping off RIGHT NOW"** — a creator is live, a code just dropped,
someone famous might be on. Caiden schedules the surge; the audience just
sees a surge.

**Operating unit: the surge window** — 2–3 hours where every booked channel
fires at once. Publicly it has no name, no calendar, no recurrence anyone can
see. It looks like a moment that's happening; it is actually a booking sheet.

## Positioning — what we say

Two messages, used for different audiences:

1. **"Omegle, but with your friends."** Party Mode + Stay Together is the
   wedge — no incumbent (Monkey, OmeTV, Emerald, Nightcap) leads with
   *group* random chat. Solo random chat is scary/cringe to admit wanting;
   doing it **with a friend next to you** is a hangout activity, and two
   friends reacting on a couch is inherently better TikTok footage than one
   person alone.
2. **"The moderated one."** Post-Omegle, the press narrative for this whole
   category is safety. 18+ gate, NSFW auto-skip on *every* tile (friends
   included), link filter, report trail. This is the message for press,
   Reddit, and skeptics — not for TikTok, where safety talk kills hype.

Secondary honest hooks: free, no app install, no signup to start, works in
the phone browser. "No download" is a real edge over Monkey (app-only) and
it's what makes hype convert: the gap between *seeing* the clip and *being
on the site* is ten seconds.

## The hype engine — three mechanics that create FOMO

These are what replace "come to our event." All three use features that
already exist:

1. **Code drops.** A creator, mid-TikTok-Live or in a story, drops a 4-char
   party code: "first 3 in `olumie.chat/#K7QX` are on my screen." Parties cap
   at 4, so slots are genuinely scarce — gone in seconds, then another code
   drops. Scarcity + race + a shot at being on a creator's stream. This is
   the single most hype-native thing the product can do and it costs nothing.
2. **The celebrity-hunt rumor.** Creators go on the site *unannounced* and
   clip people's reactions when they realize who they matched ("KSI on
   Omegle" was an entire genre). The durable rumor — "apparently people run
   into creators on olumie" — gives every visit lottery-ticket energy. Never
   confirm or deny appearances from the brand account; the rumor is the
   asset.
3. **Surge visibility.** The site itself signals when it's busy (see website
   changes) so a visitor who lands during a surge *feels* the surge, clips
   it, and the clip says "this place is alive" — the social proof loop.

## Channel plan, in priority order

### 1. TikTok — the primary engine (this is how Monkey won)

Monkey took the post-Omegle crowd almost entirely via TikTok-native UGC, not
ads. The product *is* a content machine: every call is potential footage.

**Track A — flat-fee sponsored streams (Caiden's existing plan, clustered).**
- Book **3–5 micro-creators (10k–100k followers) into the SAME window** —
  their audiences arriving together IS the liquidity. Going rate: **$50–$300
  per TikTok video/live** at this tier (80%+ of TikTok collabs run under
  $300; nano-creators under 10k often accept $20–$50 or free access). This
  category is fun to film, so creators need less convincing than usual.
- The brief: go on **with a friend** (Party Mode on camera), post a clip
  and/or go TikTok Live, and **run code drops** (mechanic #1). No "sponsored
  event" framing — the creator's own voice: "yo we found this site."
  Never let two booked creators reference each other or a shared time;
  the cluster must read as coincidence, not campaign.
- **Consent rule in every brief:** blur or crop strangers, or get on-camera
  consent before showing them. Non-consensual stranger footage gets clips
  removed, invites platform strikes, and recording audio without consent is
  illegal in some states. Filming your own side with strangers blurred is
  the standard format and performs fine.
- Measurement is already built: `/admin/stats` (visits, peakOnline,
  sessions) during the window, hourly `STATS` log as history. Pay flat fees
  manually — **the referral-link machinery stays dormant** per the
  2026-08-10 decision.

**Track B — the @olumie brand account (free, compounding).**
- Run it like a creator page, not a brand (the Duolingo/Ryanair lesson:
  post daily-ish, jump trends within hours, be self-aware and a little
  unhinged, reply to every comment wittily). A solo founder is an
  *advantage*: "I built an Omegle alternative by myself, watch what happens
  on it" is a proven viral POV.
- Content that needs no strangers' faces: screen-recorded UI moments,
  self-deprecating founder content ("POV: it's 2pm and I'm the only one on
  my own site"), stats reactions after a surge ("what happened on the site
  last night"), stoking mechanic #2 without confirming anything.
- Every clip's only CTA: **"olumie.chat"** spoken + on screen. TikTok gives
  brand searches, not link clicks — and "olumie" is exactly the query the
  site can own ("omegle alternative" won't rank for years).

**Track C — repost everything** to Instagram Reels and YouTube Shorts (same
vertical clips, zero extra work). Shorts is the sleeper: longer shelf life,
and "omegle alternative" YouTube searches still happen.

### 2. Discord — where the hype-followers pool

- **Create an official Olumie Discord**, linked subtly from the site's idle
  screen. Not an events calendar — a place where codes drop first, clips get
  posted, and "is anyone on rn" gets answered. The people who join a Discord
  *are* the calendar-followers; let them be the guaranteed baseline bodies
  in every surge without ever branding it.
- **Partner with existing mid-size Discords** (gaming, social, college,
  "make friends" servers, 1k–20k members). Party codes are made for Discord:
  a server owner drops codes in general and the server floods in together.
  Small flat fee or free — it's an activity, which active servers want
  anyway. One server = one guaranteed dense window.

### 3. Reddit — spike generator (feeds the liquidity model perfectly)

Reddit hates marketing but loves builders. Three posts, spaced weeks apart,
each timed so the resulting traffic lands on a live network (open a surge
window when posting):
- **r/InternetIsBeautiful** — "a free group Omegle you can use with a friend,
  no signup." One front-page hit is tens of thousands of visits in 48h
  (watch TURN egress if it lands).
- **r/SideProject / r/webdev / r/indiehackers** — the honest build story:
  solo dev, vanilla JS, one HTML file, WebRTC mesh, $7/mo. Devs love this,
  and devs test video chat in pairs — instant liquidity.
- **Omegle-nostalgia threads** — answer "is there a good alternative" as
  yourself (the builder), transparently. Never astroturf; this category is
  astroturfed to death and Redditors smell it.

### 4. Campus seeding — the density cheat code (September timing is perfect)

Every social app that cracked cold-start density did it on campuses
(Facebook, Yik Yak, Fizz): one timezone, one culture, dorm boredom. Fall
semester starts in ~3 weeks:
- Pick 1–2 campuses (WWU is local).
- **Campus meme pages** sell Instagram shoutouts for $20–50; brief them like
  creators — clips and code drops, not announcements.
- QR flyers ("bored? olumie.chat") cost almost nothing, and QR → browser is
  frictionless with no app install.
- If a campus catches, "the thing people at X are on lately" spreads as
  gossip — which is the hype model working on its own.

### 5. Press / blogs — free, slow, worth one afternoon

- Pitch the safety angle to the "best Omegle alternatives" listicle
  maintainers (Zegocloud, Coherent Lab, appquipo, etc.) — being added is a
  permanent backlink + steady referral trickle, and those backlinks are the
  only realistic path to ever ranking for category terms.
- Local angle: Bellingham Herald / WWU paper — "local solo developer builds
  moderated Omegle successor." Easy to land, and "my site was in the paper"
  is itself brand-account content.

### What NOT to do (each of these would actively hurt)

- **No announced schedules, no "event" branding, no countdowns from the
  brand account.** The moment concentration is visible as marketing, it
  stops being hype. Backstage only.
- **No paid ads.** Mainstream networks reject this category, the budget
  doesn't exist, and ads dribble traffic — the anti-pattern.
- **No steady-drip promotion** until baseline concurrency exists.
  Concentrate or don't spend.
- **No bought traffic/bots ever** — poisons `/admin/stats` (the only
  decision instrument) and risks the Stripe account.
- **No SEO spend** beyond the free tail (submit sitemap, request indexing).
- **No growth hack that raises dispute risk.** Dispute rate is what gets a
  high-risk merchant terminated; growth is worthless if Stripe dies.

## Website changes that multiply the above (small, high-leverage)

1. **Surge indicator** on the idle screen: when concurrency is above a
   threshold, show something alive — "🔥 busier than usual" or a (bucketed,
   honest) online count. Visitors who land mid-surge should *feel* it and
   clip it. Show nothing when quiet — never fake it, and never advertise
   emptiness either.
2. **Soften the "it's quiet" dead-end** with the Discord link: "quiet right
   now — this is where people know when it isn't." Converts a dead visit
   into a pooled future one without naming any schedule.
3. **"Join the Discord" link** on the idle screen (see channel 2).
4. **OG/share card image** — party invite links (`olumie.chat/#K7QX`) get
   pasted into iMessage/Discord/Snap constantly; a proper unfurl image is
   free advertising on every invite ("You're invited. Tap to join the
   party."). OG tags exist; make the image earn its pixels.
5. **Post-call share nudge** — after a good call ends (not before), a
   lightweight "run it back with a friend — copy invite link" moment. The
   Share button exists on the party waiting screen; the emotional peak right
   after a fun call is where invites actually happen.
6. *(Respecting prior decisions: no friends system, no iOS install hint —
   both declined 2026-08-10. Referral links stay dormant.)*

## The weekly operating loop (all backstage)

1. **Pick the window** (start Fri or Sat 8–11pm PT; one/week until a window
   sustains ~20+ peakOnline without paid help, then add a second).
2. **Book into it**: 3–5 creators with code-drop briefs + 1 Discord server +
   (first weeks) a Reddit post at window open. No public announcements.
3. **During**: watch `/admin/stats`; be online yourself; screenshot peak.
4. **After**: record per-window peakOnline / sessions / matchRate /
   `returning`; note which creator's slot moved the numbers most.
5. **Iterate**: rebook only creators who moved the numbers; raise fees for
   proven ones; drop the rest. Turn the aftermath into brand-account content
   ("what happened on the site last night") — recap as story, not event
   wrap-up.

**North-star metric: peak concurrent users per window** (`peakOnline`), not
total visits. Visits without concurrency are wasted spend. Second:
`returning` — is a habit forming? Guardrails: `matchRate` (are people
actually meeting?) and `mediaFailRate` (is TURN holding under load?).

## Budget reality

~$200–$500/month buys 3–5 micro-creator slots + a couple of meme-page
shoutouts per week at the cheap end. Everything else is free but costs
founder time — mostly the brand account (30–45 min/day) and running the
windows. At $0: brand account + Discord + Reddit + campus flyers, with
free-access nano-creators (<10k followers) instead of paid micros.

## What "guaranteed" actually looks like

Nothing guarantees virality. What this plan guarantees is **maximum shots on
goal with a working feedback loop**: every week produces 5–10 pieces of
native content in the only channels this category has ever grown from, all
landing in windows dense enough for the product to demonstrate itself,
measured by instruments that already exist. Monkey's 30M users came from
exactly this motion (TikTok UGC → brand search → word of mouth) — this plan
copies the motion and adds two things Monkey didn't have: a group mode that
makes the content better, and party codes that turn a creator's live stream
into a race.
