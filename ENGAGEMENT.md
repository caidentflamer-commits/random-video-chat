# Olumie — engagement plan

How to make the site more compelling and harder to put down. Companion to
`HANDOFF.md` (what's built) and `MARKETING.md` (how people arrive). This doc
covers what happens *after* they arrive.

Written 2026-08-21. Cut down 2026-08-23 after review — see **Declined** at the
bottom before proposing anything from it again.

## The premise

**The core loop is already a slot machine.** Skip is a lever pull, the stranger
is a variable reward, and the reward schedule is the strongest one in behavioural
psychology — variable-ratio. Nothing here needs inventing; the loop needs
*unblocking*.

What actually breaks it:

1. **The room feels empty even when it isn't.** No social proof anywhere on the
   page. A visitor cannot tell 40 people online from 0, so they assume 0.
2. **The lever is slow.** Every pull runs through a full teardown and rebuild.
   The tempo of the loop is the gap between Skip and the next face, and that gap
   is where conditioning is won or lost.
3. **There is no trigger.** No app, no notifications, no email. Coming back is
   entirely on them to remember, unprompted.

**The rule that decides what belongs here:** nothing goes between the user and
the video. Every mechanic must live in a surface that already exists — the idle
screen, the status bar, the control row, or sound. No cards, no recaps, no
interstitials. This is the same instinct as the FaceTime rework in `HANDOFF.md`
(no permanent panels, controls fade out), and it is what separated the accepted
items below from the declined ones.

---

## 1. Live user count — SHIPPED 2026-08-23

One number, on the idle screen: **`34 online`**. Not split by state, not
bucketed into adjectives, not decorated. One honest number.

Built as described below; `HANDOFF.md` carries the implementation notes. Read
`startRate` before and after a surge window — that is the whole point of it.

- **Principle:** social proof. People join what looks joined, and right now the
  page gives no evidence either way — so a first-time visitor assumes empty.
- **Where:** `wss.clients.size` is already the number, and `stats.peakOnline`
  already tracks its ceiling (`server.js:1520`).
- **Plumbing gotcha:** the WebSocket only opens when someone presses Start, so
  the *idle* screen has no channel to receive this on. Ride it on the existing
  `POST /visit` response (already fires on page load) plus a small `GET /pulse`
  poll every ~20s while `phase === 'idle'`. **Don't open the socket early** —
  that changes what `starts` counts and silently breaks `startRate`.
- **Below a threshold, show nothing at all.** Not a low number, not a fake one.
  Emptiness is the one fact that must never be advertised, and a fabricated count
  is the one thing that — screenshotted next to an empty room — ends the brand.
- **Measured by:** `startRate` (visited → pressed Start). That is the number this
  is meant to move, and it is currently the weakest one on `/admin/stats`.

## 2. Make the lever faster

No UI at all. The gap between pressing Skip and seeing the next face is the
loop's tempo, and it compounds over dozens of pulls in a single sitting — a
faster reward is a stronger conditioner, for free.

- **Principle:** reinforcement immediacy. The shorter the delay between action
  and reward, the tighter the association.
- **Where to find the time:** keep a warm `RTCPeerConnection` with ICE
  pre-gathered instead of building one per match; never tear down the local
  camera between calls; re-queue optimistically on Skip rather than waiting for
  the server to acknowledge.
- **Constraint:** the NSFW sampler reads `els.local` and each remote `<video>`,
  so those elements must stay mounted and playing. Speeding up the loop must not
  turn the scanner off between calls.
- **Measured by:** nothing on `/admin/stats` sees this today. Add one client
  timing counter (skip → remote track playing) or it can't be judged.

## 3. Sound

A short connect tone and a skip whoosh. Audio feedback is most of why TikTok and
slot machines feel good, and it costs zero screen space — which is the whole
reason it survives the rule above.

- **Principle:** conditioned reinforcement. A consistent sound at the moment of
  reward becomes the reward's cue, and cues fire faster than the thing itself.
- **Where:** WebAudio, generated — no asset file, nothing to load, nothing to add
  to the CSP.
- **Default off is wrong; default on with an obvious mute is right.** Autoplay
  policy means the first sound must follow a user gesture anyway (Start counts).

## 4. The return trigger — open question

Once the tab closes, Olumie has no way to reach anyone. Options, cheapest first:

- **Discord.** A place they already check. Free, and `MARKETING.md` wants it
  anyway. Do this regardless of the rest.
- **Home-screen icon.** Shipped. A passive trigger — it only works if the install
  chip converts, so watch it.
- **Web push.** The real answer, and the one with a decision attached: push needs
  a service worker, and Olumie has **deliberately no service worker**
  (`HANDOFF.md`) because offline caching is pointless for live video and SW
  staleness is a real risk. A *push-only* worker — no `fetch` handler at all, so
  it can never serve a stale asset — sidesteps the stated reason, but it is still
  a new moving part in exchange for one notification. On iOS it also requires the
  site be added to the home screen first.
  **If it ships, one notification type only: "it's busy right now."** Anything
  else trains people to swipe it away. **Undecided.**

---

## Lines not to cross

- **Never fake the count and never fake a match.** A fabricated online number is
  the one thing that gets screenshotted next to an empty room, and this audience
  is unusually good at spotting it.
- **Never punish absence.** Nothing that costs the user something for not
  showing up.
- **Never add friction to leaving or cancelling.** Dispute rate is what
  terminates a high-risk merchant; the honest upgrade modal (PR #32) stays honest.
- The 18+ gate and the moderation stack are what make aggressive engagement
  defensible here. Non-negotiable regardless of what this doc adds.

## Measuring it

- **Every mechanic ships with exactly one counter**, or it can't be judged.
- **A/B testing is not available at this traffic** — a split test needs more
  sessions per arm than a surge window produces. Compare window to window, one
  change at a time; the weekly loop in `MARKETING.md` step 4 is where the numbers
  get written down.
- **Counters reset on deploy.** The hourly `STATS` log line is the only history.

## Declined — do not re-pitch

Reviewed and rejected 2026-08-23. Each was an **interstitial** — a screen between
the user and the video — which is the pattern to avoid, not a detail to fix.

- **Split user counts** ("in calls" vs "looking"). One number, undecorated.
- **"Stay in line"** — camping the queue with a chime when someone appears.
  Rejected on the premise that with active users there is no waiting to absorb;
  it was a cold-start mechanic only.
- **Curiosity card at match** ("Someone in Germany · you both picked music").
  Too much.
- **Session recap on Stop** (minutes / people / countries + share nudge).
  Nobody wants a report card.
- **Return streak** ("you've been back 6 times").
- **Priority matching as a Premium perk.** Dies on the same premise as
  stay-in-line: no queue, nothing to skip.

Standing decisions this plan also respects, from `HANDOFF.md`:

- **No friends system** (declined 2026-08-10).
- **No iOS install hint** (declined 2026-08-10).
- **Referral links stay dormant** — flat-fee sponsorship is the model.
- **No visible schedules, countdowns, or event branding** anywhere on the site.
