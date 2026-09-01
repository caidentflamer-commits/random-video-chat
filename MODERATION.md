# Moderation & report logging

What Olumie does automatically, and how to review reports. **Automated checks
are a filter, not a replacement for a human reading reports** — this gives you
the trail to do that.

## What's automated

- **Age / rules gate** — first visit requires confirming 18+ and agreeing to the
  rules (no nudity/harassment/illegal). Remembered per browser.
- **Self-camera check** — nsfwjs samples the user's *own* camera; repeated
  explicit frames disconnect them (3 strikes → blocked). Fail-safe: if the model
  can't load, it's off rather than blocking everyone.
- **Remote-camera check** — samples the *other* people's video too, round-robin,
  one per tick. On explicit content it auto-skips and **reports** them.
  **Everyone is sampled, including people in your own party**, and every tile
  keeps its report flag. This used to exempt "friends", on the assumption that a
  friend was someone you knew — but a party is reachable by sharing a 4-character
  code, or by two strangers agreeing to stay together mid-call, so `friend` was
  never a statement about trust. Exempting it made opting out of moderation a
  two-tap operation. **Don't reintroduce the exemption**: `friend` means "stays
  with me across Next", nothing more.
- **Chat link filter** — links are blocked client-side and stripped server-side
  (anti-scam).
- **Reports & bans** — a report never bans on its own. It always disconnects
  the pair and is always recorded. A **ban** additionally requires a visual
  reason (Nudity, or an `auto:` detection) *and* a positive classification of
  frames the reporter’s own browser already sampled — plus room in the
  reporter’s ban budget (5/hour) and the site-wide breaker (30/hour).
  Everything else — Harassment, Under 18, Spam or scam, Something else, and any
  visual report that came back clean — waits for a human. It arrives in Discord
  as a card with Ban / Dismiss buttons (see `DISCORD.md`); `/admin/review` is
  the same list as JSON. "Report last" now shows thumbnails of the last few
  strangers and reports **only the one picked**; it used to ban the whole batch.

  Each card carries a **History** line — how many times that address has been
  reported in the last 7 days, and by how many DIFFERENT reporters. Distinct
  reporters is the number to read: ten reports from one address is one person
  with a grudge, three from three addresses is a pattern a lone griefer cannot
  manufacture. Since a moderator cannot see the frame, this is the strongest
  evidence available to them. The card only turns red at two or more distinct
  reporters — a single report should not look like a verdict before you read it.

  **Exempt targets never reach the queue.** Someone on BAN_EXEMPT_IPS or
  BAN_EXEMPT_USER_IDS cannot be banned, so there is no decision to make and the
  card would be a Dismiss button with nothing behind it. Reports about them are
  still logged, still in /admin/reports and the durable reports table, and still
  count toward report history — out of the queue, not out of the record.

  Those thumbnails never leave the browser. Frames are held in the reporter’s
  tab for 30s and only a verdict made of numbers is transmitted — no image is
  stored on any server, deliberately. See the CSAM note below for why.

## Why a majority of frames, not one

Calibration showed the classifier is well behaved most of the time but spikes on
the odd frame — motion blur, a shot caught mid-movement, a compression artifact.

The auto path was always safe from that: `TRIPS_BEFORE_ACTION` needs two
**consecutive** samples and any clean frame resets the counter. The manual
report path was not. `verdictFor()` marked a report explicit if **any one** of
the three retained frames tripped, so a single spike sitting anywhere in the
buffer could confirm a malicious report and ban an innocent person
automatically, with no human in the loop.

Now a **majority** of the scored frames must trip. Real explicit content is in
every frame rather than one, so a genuine report loses nothing, and a lone spike
confirms nothing. It also removes the old asymmetry where a human-initiated
report cleared a lower bar than the detector applied to itself.

The server re-derives this from `tripped`/`frames` rather than trusting the
client's `explicit` boolean — a client whose own counts contradict its
conclusion is either running stale code or forging clumsily, and neither should
ban anyone. **Note the deploy consequence:** a browser still running the old JS
sends no `tripped` field, reads as 0, and its reports queue for review instead of
banning. Fail-safe, and it clears itself on reload.

## Picking the thresholds

`EXPLICIT_THRESHOLD` (0.60) and `SEXY_THRESHOLD` (0.85) came from nsfwjs, not
from measurement. To check them against reality, open **olumie.chat/#calibrate**
on a phone or a laptop: the camera starts without entering matchmaking and a
live readout shows what your own face and room actually score.

Read the **peak** column, not `now` — a false positive comes from the worst
frame in a few minutes, not the current one. Tap the box to reset peaks between
poses. Do the innocent-but-awkward things: dim room, backlit window, changing a
shirt, someone walking past. If your worst honest moment sits near 0.15 there is
plenty of headroom; if something ordinary reaches 0.4, raise
`TRIPS_BEFORE_ACTION` rather than the threshold — noise is uncorrelated between
frames and real content is not, so persistence is the stronger filter.

The overlay is invisible without the hash and reads only your own local video:
no peers, no reports, no side effects for anyone else.

## If a report involves a minor

Reference for the moment it's needed, not a task. In the US, a service that
becomes aware of apparent CSAM is **legally required to report it to NCMEC**
(CyberTipline: report.cybertip.org — 18 U.S.C. § 2258A). Preserve the report
record (it's already durable in Supabase); don't delete it. Ban the account/IP
as usual. This is the one category of report where "handle it later" has legal
consequences.

## Live observation (2026-08-31)

An authorised moderator can join a call in progress from **`/watch.html`**,
receive video, and ban a participant. They send nothing — no camera, no
microphone, no chat — and **nothing is recorded anywhere**. There is no
`MediaRecorder`, no canvas capture and no upload path on that page. Do not add
one; that turns this into the thing declined below.

- **Authorisation is the Supabase user id**, via `OBSERVER_USER_IDS`. The URL is
  unlisted but is **not** the control — an account not on that list gets an empty
  list and nothing else. Unset means nobody can observe.
- **Participants are not told.** Deliberate: a visible indicator only tells
  someone breaking the rules when to stop. This is why the disclosure in the
  Terms is what makes the feature legitimate, and is not optional.
- **Disclosed in `terms.html` §3 and `privacy.html`** ("Live moderation").
  ⚠ **Caiden declined putting it at the age gate** (2026-08-31) on the grounds it
  would turn people away. It was raised that clickwrap consent at the gate is
  materially stronger than consent buried in terms, and that courts are
  unimpressed by buried consent for contemporaneous interception. Decision
  recorded, not re-litigated — but if a lawyer ever looks at this feature, that
  is the first thing they will ask about.
- **Every observation is logged and announced** — `OBSERVE …` in the server logs
  plus a Discord ping naming the account and the session. That is what protects
  the moderator if they are ever accused of something.
- **It cannot damage a call.** The participant's browser treats the extra
  connection as strictly optional (`addHiddenPeer` — no tile, not in `peers`, no
  ICE recovery, no stats, silent failure), so a broken observation can never
  interrupt, degrade or reveal itself through the UI.
- ⚠ **The participant-facing messages are their own types — `observe-peer` and
  `observe-peer-leave` — NOT flags on `peer-join`.** This is the fix for a real
  bug: a tab open across the deploy is still running the old script, which had
  no idea what a `hidden` flag meant and fell through to `addPeer()`, putting a
  blank stranger's tile on the person's screen the moment a moderator joined.
  An unknown message type hits no case and is ignored, so an old client simply
  doesn't connect — the moderator gets no video from them and the user sees
  nothing. **Never move this back onto `peer-join`**; observation must fail
  invisible, never visible.
- **Observers are excluded from `N online` and `peakOnline`.** Someone watching
  is not someone you can be matched with, and counting them would be the site
  inventing a body.
- **Chat is untouched.** Observers are deliberately not in `roomMembers()`, so
  every room-scoped message — chat included — continues to ignore them. Only
  WebRTC signalling crosses the boundary (`signalPeers()`).
- **Bans go through `banIp()`** like every other path, so exemptions, the
  durable record, the ledger and the Undo card all apply unchanged.

⚠ **This is not a ban-review tool and cannot become one.** `banSocket()` closes
the banned socket within 300ms, so by the time a notification reaches a phone
the session is gone. It is a patrol tool.

## Asked for and declined: frames attached to the ban message (2026-08-31)

The request was reasonable and the underlying complaint was right — you only
heard about a ban after the fact, with no evidence and no way to reverse it.
The answer was **not** to attach camera captures, even privately, even to a
short list of trusted moderators.

Bans here are overwhelmingly for nudity, and this document already records that
the subjects are occasionally minors. Sending those frames to Discord means
transmitting and storing images of possibly-nude, possibly-underage strangers on
a third party's servers, on top of this one — with the legal duties above
attaching to every copy. Restricting who can view them changes who looks, not
what is being stored.

**What was built instead**: every ban now posts a card with the reason, the
target IP, that address's report history, and the classifier verdict — with
**Undo this ban** on it, plus a `/bans` command that lists active bans when the
card can't be found. That gives full review over every ban. The difference is
that you review *the decision and its evidence*, not the person's body. See
`DISCORD.md`.

## Where reports go (three layers)

Every report — manual or auto — is recorded via `logReport()`:

1. **Server logs.** Each one prints a line starting with `REPORT ` as JSON.
   View in **Render → your service → Logs** and filter for `REPORT`. Retained
   for Render's log window.
2. **`/admin/reports` endpoint.** Returns the recent reports (newest first) as
   JSON. **Gated** — set an env var `ADMIN_KEY` and call:
   ```
   https://<your-app>/admin/reports?key=YOUR_ADMIN_KEY
   ```
   With no `ADMIN_KEY` set, the endpoint is disabled (403) so report data (which
   includes IPs) is never public. Keep the key secret; don't share the URL.
   Buffer holds the last 500 and resets on restart/redeploy.
3. **Webhook push (recommended, durable).** Set `REPORT_WEBHOOK_URL` to a
   **Discord channel webhook** (or any endpoint that accepts `{ "content": "…" }`)
   and every report is POSTed there in real time. This is the one that survives
   restarts and pings your phone — best for actually keeping an eye on it.

### Each report record
```json
{
  "ts": "2026-08-01T12:00:00.000Z",
  "kind": "user-report | auto-moderation | report-last",
  "reporter": "u12", "reporterIp": "…",
  "target": "u9", "targetIp": "…",
  "reason": "Nudity", "note": "optional text from the reporter",
  "action": "banned"
}
```
`kind: auto-moderation` = the remote-camera check flagged it (not a human).

## Set it up on Render

Dashboard → your service → **Environment**:
```
ADMIN_KEY=<a long random string>          # enables /admin/reports
REPORT_WEBHOOK_URL=<your Discord webhook>  # optional but recommended
```
To make a Discord webhook: a Discord server → Channel settings → Integrations →
Webhooks → New Webhook → Copy URL.

## Honest limitations

- IP bans and the in-memory report buffer **reset on restart/redeploy**. The
  webhook (Discord) is your durable record; a database would be the next step if
  you outgrow it.
- ML moderation **false-positives and misses** — tune thresholds in
  `public/index.html` (`EXPLICIT_THRESHOLD`, `SEXY_THRESHOLD`, `TRIPS_BEFORE_ACTION`).
- It only runs in browsers that load the model; a determined bad actor can
  bypass client-side checks. **Human review of the report feed is the real
  backstop** — especially anything involving minors or illegal content, which
  carries legal obligations.
