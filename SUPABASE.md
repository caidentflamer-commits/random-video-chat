# Phase 1 — Accounts + database (Supabase)

Adds real user accounts and a durable database, so the app can (a) remember who
someone is across sessions, (b) keep bans after a restart, and (c) later attach
subscriptions to a user. Auth method to start: **email magic-link** (no passwords,
no extra OAuth setup). Google sign-in can be added later.

## Your 5-minute setup

1. **Create the project** — [supabase.com](https://supabase.com) → **New project**.
   Pick a region near you, set a database password (save it somewhere).
2. **Run the schema** — left sidebar → **SQL Editor** → **New query** → paste the
   entire contents of [`db/schema.sql`](db/schema.sql) → **Run**. You should see
   `Success`. This creates the `profiles`, `bans`, and `reports` tables.
3. **Grab the keys** — **Project Settings → API**. You need four values:

   | Value | Set as Render env var | Secret? |
   |---|---|---|
   | Project URL | `SUPABASE_URL` | public |
   | `anon` `public` key | `SUPABASE_ANON_KEY` | public (browser-safe) |
   | `service_role` key | `SUPABASE_SERVICE_KEY` | **secret — server only** |
   | JWT Secret (API → JWT Settings) | `SUPABASE_JWT_SECRET` | **secret — server only** |

4. **Add all four** in Render → your service → **Environment**. That's it — you
   don't need to paste any of them into chat; the app reads them from the env.
   (The browser fetches only the two public ones, via a `/config` endpoint.)

## How it works once configured

- The browser loads the Supabase client and offers a **magic-link sign-in**
  (enter email → click the link → you're in). Anonymous use still works; sign-in
  unlocks account-tied features.
- On connecting, the browser sends its Supabase session token; the **server
  verifies it** with `SUPABASE_JWT_SECRET` to know who the user is.
- **Bans and reports are written to the database** (durable), with the in-memory
  path as a fallback when Supabase isn't configured — so nothing breaks before
  you set the env vars.

## Safe rollout

With none of these env vars set, the app behaves exactly as it does today
(anonymous, in-memory bans). Everything activates only once the four vars exist.

## What comes after (Phase 2)

Subscriptions: Stripe Checkout for a recurring plan → webhook flips
`profiles.is_premium` → premium features gate on it. The `profiles` table is
already set up for it.
