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

   Newer Supabase projects show these exact names — you can literally "Copy all":

   | Supabase value | Render env var | Secret? |
   |---|---|---|
   | Project URL | `SUPABASE_URL` | public |
   | Publishable key (`sb_publishable_…`) | `SUPABASE_PUBLISHABLE_KEY` | public (browser-safe) |
   | Secret key (`sb_secret_…`) | `SUPABASE_SECRET_KEY` | **secret — server only** |
   | JWKS URL | `SUPABASE_JWKS_URL` | public (used to verify logins) |

   (The server also accepts the classic names `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_KEY`
   if your project shows the legacy keys instead.)

4. **Add all four** in Render → your service → **Environment**. That's it — you
   don't need to paste any of them into chat; the app reads them from the env.
   (The browser fetches only the two public ones, via a `/config` endpoint.)

## Adding Google sign-in (recommended)

Magic link costs an email round trip on **every new browser or device**, and on
iOS Safari the stored session gets evicted after ~7 days of light use — so it
feels like "signing in every time". Google is one tap and re-authenticates
anywhere. It sits right in the upgrade funnel, so it's worth doing.

The app already has the button; it **stays hidden until Google is actually
enabled** on the project (it checks `/auth/v1/settings` at load), so there's
nothing to deploy after you finish these steps — just reload.

1. **Google Cloud Console** → [console.cloud.google.com](https://console.cloud.google.com)
   → create (or pick) a project.
2. **APIs & Services → OAuth consent screen** → **External** → fill in app name,
   support email, developer email. Add scopes `.../auth/userinfo.email` and
   `.../auth/userinfo.profile`. While it's in **Testing**, only accounts you add
   as test users can sign in — hit **Publish app** when you're ready for everyone.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   type **Web application**.
   - **Authorised JavaScript origins:** `https://random-video-chat-azkk.onrender.com`
   - **Authorised redirect URI:** `https://<your-project-ref>.supabase.co/auth/v1/callback`
     (Supabase shows this exact URL on the Google provider page — copy it from there.)
4. Copy the **Client ID** and **Client secret**.
5. **Supabase dashboard → Authentication → Providers → Google** → toggle on,
   paste both values → **Save**.
6. Reload Olumie — **Continue with Google** now appears above the email field.

Also check **Authentication → URL Configuration**: **Site URL** must be the
Render URL (not localhost), and the redirect allow-list should include it — the
same requirement magic link already has.

> On a custom domain later (`olumie.chat`), add it to the Google origins list and
> to Supabase's Site URL / redirect allow-list, or sign-in breaks on the new domain.

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
