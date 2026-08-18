# Discord is the admin surface

There is no admin web page. A report that needs a human arrives in Discord as a
card with **Ban this IP** and **Dismiss** on it, so acting on one is a phone
notification and a tap. `/stats` and `/queue` cover the rest.

Everything below is inert until the env vars are set — the app runs fine
without any of it, and falls back to the old one-line `REPORT_WEBHOOK_URL` ping
so nothing goes silent while you're setting this up.

## Why a bot and not the existing webhook

The channel webhook Olumie already uses **cannot** carry buttons. Discord's rule:
*"Non-application-owned webhooks cannot send interactive components, and the
`components` field will be ignored."* Only an application can attach them, so
this needs a real bot token. `REPORT_WEBHOOK_URL` still works and is still used
for the plain pings (ban-breaker alerts, and queued reports if the bot is unset).

## Setup

**1. Make the application.** <https://discord.com/developers/applications> →
New Application. From **General Information**, copy the **Public Key** and the
**Application ID**.

**2. Make the bot.** Bot tab → Reset Token → copy it. This token can post as the
bot; treat it like a password. It does **not** need any privileged gateway
intents — the app only makes REST calls and receives interactions over HTTPS.

**3. Invite it to your server.** OAuth2 → URL Generator → scopes `bot` and
`applications.commands`, bot permission **Send Messages**. Open the generated
URL and add it to the server.

**4. Get the channel id.** Discord Settings → Advanced → Developer Mode on, then
right-click the moderation channel → Copy Channel ID. Same trick on your own
name gives your **user id**.

**5. Set these on Render** (Environment → Add):

| Variable | What it is |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot tab → Token |
| `DISCORD_CHANNEL_ID` | The channel cards get posted to |
| `DISCORD_PUBLIC_KEY` | General Information → Public Key |
| `DISCORD_ADMIN_IDS` | Comma-separated user ids allowed to press the buttons |
| `DISCORD_APP_ID` | Only needed to register the slash commands |

`DISCORD_ADMIN_IDS` is the important one. Everyone in the channel can *see* a
card; only ids on this list can act on it. **Unset means nobody can act** — that
is deliberate. The alternative is every member of the server holding the ban
hammer.

**6. Point Discord at the endpoint.** General Information → **Interactions
Endpoint URL** → `https://olumie.chat/discord/interactions` → Save.

Discord verifies it by sending deliberately-invalid signed requests and checking
they're rejected with a 401. If it saves, signature verification is working. If
it refuses to save, `DISCORD_PUBLIC_KEY` is wrong or the deploy hasn't finished.

**7. Register the slash commands** (once, and again whenever they change):

```bash
DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node tools/register_discord_commands.js
```

Global commands can take an hour to appear. Add `DISCORD_GUILD_ID=...` to
register them to one server instantly while testing.

## What you get

**A card per queued report** — reason, target IP, reporter IP, why it landed in
the queue rather than banning automatically, the note, and the classifier scores
if there were any. Two buttons. Pressing one edits the card in place, stamps who
decided it, and removes the buttons so the channel shows the outcome instead of
a stale pair of tempting buttons.

**No images, ever.** Frames stay in the reporter's browser; only numbers are
transmitted. See `MODERATION.md` for why that line is not worth crossing.

| Command | Does |
|---|---|
| `/stats` | Online, peak, page loads, browsers, sessions, skips, reports, bans, queue depth |
| `/queue` | Reposts the waiting reports as fresh, actionable cards |
| `/whoami` | Proxy-hop config, for checking `TRUSTED_PROXY_HOPS` |

All three reply **ephemerally** — only you see the output, so the channel
doesn't fill with numbers.

## Still there for curl

The JSON endpoints are unchanged and take either `?key=ADMIN_KEY` or an
`X-Admin-Key` header:

```bash
curl -s -H "X-Admin-Key: $ADMIN_KEY" https://olumie.chat/admin/data
```

`/admin` (index), `/admin/data`, `/admin/stats`, `/admin/review`,
`/admin/reports`, `/admin/whoami`, and `POST /admin/review/act` with
`{"id":N,"action":"ban"|"dismiss"}` — the same decision the buttons make, via
the same `decideReview()`.

## Gotchas

- **The queue is in memory and empties on deploy.** Buttons on old cards will
  say the item is gone. Reports themselves stay durable in Supabase; the pending
  *decisions* do not. If you're mid-triage, decide before you deploy.
- **Discord wants a reply within 3 seconds.** Everything the handler does is
  in-memory, and the Supabase ban write is fire-and-forget, so this is fine —
  but don't add a blocking call to that path without deferring the response
  (`type: 5`) first.
- **A button press is authorised by user id, not by channel permissions.** Moving
  the channel or changing who can see it does not change who can ban.
