# Google Search Console — setup & reference

How Olumie is set up in Google Search Console (so search engines find it), and
how to redo it if the URL changes.

**Live URL:** `https://random-video-chat-azkk.onrender.com`
(Confirm in the Render dashboard → service page. If you move to a custom domain,
see "If the URL changes" at the bottom.)

## What's already in the code

- **Verification tag** in `public/index.html` `<head>`:
  ```html
  <meta name="google-site-verification" content="Svey5jK-1rZb9ZG1HTn-lkXDKsPp_rWmDDZVFQfax7k" />
  ```
  Leave it there — removing it un-verifies the site.
- **`public/robots.txt`** — allows all crawlers, points to the sitemap.
- **`public/sitemap.xml`** — lists the homepage.
- SEO tags in `<head>`: title, meta description, canonical, Open Graph/Twitter.

## First-time setup (done once)

1. Go to **https://search.google.com/search-console** and sign in.
2. **Add property → URL prefix** (not "Domain" — that needs DNS access we don't
   have on an `.onrender.com` subdomain). Enter the full URL:
   `https://random-video-chat-azkk.onrender.com`
3. **Verify → HTML tag** method. Google shows a
   `<meta name="google-site-verification" …>` tag; it's already in the page head
   (see above), so just click **Verify**. It passes instantly.
4. **Sitemaps** (left menu) → add `sitemap.xml` → **Submit**. Should read "Success".
5. Optional, for a faster first crawl: **URL Inspection** → paste the homepage →
   **Request indexing**.

## Checking on it later

- **Pages** (or "Coverage"): shows what Google has indexed and any errors.
- **Performance**: impressions/clicks once you're ranking.
- Quick check anytime: search Google for
  `site:random-video-chat-azkk.onrender.com` — indexed pages show up there.

## What to expect

- Verification: instant.
- Indexing: **days to a few weeks** — normal, not a bug.
- The Render free tier **sleeps after ~15 min idle**, so Google's crawler
  occasionally hits a waking (HTTP 503) page. It retries, so it's fine; a paid
  Render tier (no sleep) improves crawlability if you scale up.

## If the URL changes (custom domain, new Render URL)

Tell whoever's maintaining the code to update the URL in **four** places, then
redeploy:
- `public/robots.txt` (the `Sitemap:` line)
- `public/sitemap.xml` (the `<loc>`)
- `public/index.html` — `<link rel="canonical">` and `og:url`

Then in Search Console, **add the new URL as its own property** and re-verify +
re-submit the sitemap (Search Console properties are per-exact-URL). If it's a
custom domain, you can use a **Domain property** (verified via a DNS TXT record)
instead of URL-prefix.

## Related

- On-page SEO and content live in `public/index.html`.
- TURN/relay config: `TURN.md`. Hosting/deploy: `DEPLOY.md`.
