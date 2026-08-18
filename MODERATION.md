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
  visual report that came back clean — waits at **/admin/review?key=ADMIN_KEY**
  for a human. "Report last" now shows thumbnails of the last few strangers and
  reports **only the one picked**; it used to ban the whole batch.

  Those thumbnails never leave the browser. Frames are held in the reporter’s
  tab for 30s and only a verdict made of numbers is transmitted — no image is
  stored on any server, deliberately. See the CSAM note below for why.

## If a report involves a minor

Reference for the moment it's needed, not a task. In the US, a service that
becomes aware of apparent CSAM is **legally required to report it to NCMEC**
(CyberTipline: report.cybertip.org — 18 U.S.C. § 2258A). Preserve the report
record (it's already durable in Supabase); don't delete it. Ban the account/IP
as usual. This is the one category of report where "handle it later" has legal
consequences.

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
