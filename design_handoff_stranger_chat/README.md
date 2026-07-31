# Handoff: Stranger video chat — layout & flow redesign

## Overview
Redesign of an existing random 1-to-1 video chat site (currently `random-video-chat-azkk.onrender.com`).
The old chat screen gave its whole height to two empty black boxes, split its actions across three
competing button rows, and showed a red "Safety check: off" badge. The redesign:

- Collapses the product to **two pages**: a landing page and a single chat page.
- Gives the chat page **three states** (idle / searching / connected) inside one unchanging shell, so
  nothing shifts as the user matches and skips.
- Turns the actions into **two large buttons** (Skip, Stop) sized to match the chat panel.
- Replaces the red safety badge with a **small green shield icon**.
- Adds a **"Report last"** affordance so a user can still report someone after skipping.
- The pre-call lobby that existed in early explorations was **cut** — its interests/country/language
  controls now live in the idle state of the chat page itself.

## About the design files
The files in this bundle are **design references created in HTML** — prototypes showing the intended
look and behaviour, not production code to paste in. The task is to **recreate these designs in the
target codebase's existing environment** (the current site appears to be a server-rendered HTML/JS app
with WebRTC + sockets) using its established patterns. `clarity.css` is a real, complete stylesheet and
CAN be adopted directly if the project has no design system of its own.

## Fidelity
**High fidelity.** Colors, typography, spacing, radii and states are final and come from the Clarity
design system (`clarity.css`). Video content is represented by placeholder tiles — wire the real
`<video>` elements in their place (`.c-tile > video` is already styled to cover the tile).

---

## Global shell (identical in every state)

Page wrapper: `class="c-root c-stage"` — `.c-stage` is the dark theme remap. Also apply the dark brand
ramp on that wrapper (the design system only ships it under `:root[data-theme="dark"]`):

```css
--primary:#6d63ff; --primary-hover:#8078ff; --primary-active:#5a50f0;
--accent:#38bdf8; --danger:#fb5f7a; --danger-hover:#ff7a90;
--online:#3fcf6b; --warning:#f0a92e;
```

Vertical structure, top to bottom:

1. **Status bar** — `display:flex; justify-content:space-between; padding:8px 20px; border-bottom:1px solid var(--border)`
   - Left: 16×16 rounded square in `var(--primary)` (logo placeholder) + product name, `600 13px Inter`.
   - Centre: state badge only (`Connected · 00:42` with a pulsing `.c-dot--live`, or nothing while idle).
     No online count, no interests, no country/language here — deliberately removed.
   - Right: 26px circular green shield icon (inline SVG, stroke `var(--online)`, background
     `var(--online-tint)`, `title="Safety checks on"`) + 30px `.c-iconbtn` settings gear.
2. **Video row** — `display:grid; grid-template-columns:1fr 1fr; gap:16px; padding:14px 24px 0`.
   Both tiles `.c-tile` with `aspect-ratio:16/10` (deliberately taller than the old 16/9).
   Each tile carries a `.c-tile__name` pill bottom-left. The stranger's tile carries a 34px circular
   **red flag report button** top-right (`background:var(--scrim)`, `backdrop-filter:blur(6px)`,
   flag SVG stroked/filled `var(--danger)`, `title="Report"`).
3. **Bottom row** — `display:grid; grid-template-columns:1fr 1fr; gap:24px; align-items:stretch; padding:16px 24px 22px`
   - **Left half = chat.** A log panel (`background:var(--surface)`, `1px solid var(--border)`,
     `border-radius:var(--r-md)`, `padding:12px 14px`, `min-height:130px`, `flex:1`, messages bottom-aligned,
     `gap:8px`, each message `14px` with the sender name in `var(--text-muted)` and `margin-right:8px`),
     then a **34px-tall** input row: `.c-input` (`height:34px`, `padding:0 12px`, `font-size:var(--fs-sm)`,
     `border-radius:var(--r-sm)`) + `.c-btn.c-btn--secondary.c-btn--sm` "Send" (`height:34px`).
   - **Right half = actions.** A row of big buttons filling the same height as the chat log
     (`display:grid; grid-template-columns:2fr 1fr; gap:12px; flex:1; min-height:130px`), then a **34px-tall**
     control row that lines up with the message bar: two 34px `.c-iconbtn.c-iconbtn--active` (mic, camera)
     plus small right-aligned links.

The two bottom columns are intentionally the same height and share the same 34px second row — the buttons
must stay flush with the chat panel and the message bar.

---

## Screens / views

### 1. Landing page (`/`)
Purpose: one promise, one button, proof of moderation above the fold.
- Header: logo + name left; "How it works · Safety · Guidelines" (`var(--fs-sm)`, `var(--text-muted)`)
  and a `.c-btn.c-btn--secondary.c-btn--sm` "Sign in" right.
- Hero: `display:grid; grid-template-columns:1.05fr .95fr; gap:56px; padding:64px 32px 48px`.
  Left column: `.c-label` eyebrow in `var(--primary)` ("Moderated 1-to-1 video chat"), a 46px
  `.c-display` headline ("Talk to someone new. / Ten seconds, no signup."), a `.c-body.c-muted`
  value line, then `.c-btn.c-btn--lg` "Start chatting" + `.c-btn.c-btn--ghost.c-btn--lg` "Text-only mode",
  then a wrapping row of `.c-badge`s (moderation, 18+, nothing recorded).
  Right column: a `.c-tile.c-tile--hero` product still with `box-shadow:var(--shadow-lg)`.
- Below: three `.c-card`s in `grid-template-columns:repeat(3,1fr); gap:16px` — "Matched on interests",
  "One tap to leave", "Reports get read".
- Landing copy is the one place the live-user count may reappear if you want it; it was removed from the app shell.

### 2. Chat page — state A: idle / first load (design ref `3a`)
Purpose: replaces the old "No stranger yet" void. Everything the user needs before matching.
- **Left tile** is not video: `background:var(--surface)`, contents vertically centred, `padding:32px`, `gap:14px`:
  `.c-h2` "Ready when you are.", a `14px` `.c-body.c-muted` explainer, then a wrapping `gap:8px` row of
  `.c-chip`s — two `.is-selected` interests with `.c-chip__x`, "+ interests", "Anywhere ▾", "English ▾".
  Country/language are chips here (and only here).
- **Right tile** is the user's camera preview, `.c-tile__name` = "You · this is what they'll see".
- Bottom-left: chat panel with a centred `.c-help` line ("Text chat opens here the moment you're matched.
  Nothing you type is saved."), message bar disabled.
- Bottom-right: one full-height `.c-btn.c-btn--lg` **Start** (`min-height:130px`, `font-size:var(--fs-xl)`),
  then mic/camera icon buttons and the rules line as `.c-help`:
  "18+ only. No nudity or harassment — report anyone, we read every one."
  (This single line replaced a full pre-call rules banner + lobby step.)

### 3. Chat page — state B: searching (design ref `2a`)
- Status bar centre is empty (the search message appears once, in the tile — not twice).
- **Left tile**: `background:var(--surface)` + `.c-connecting` centred: `.c-spinner.c-spinner--lg`,
  `.c-h2` at `var(--fs-lg)` "Looking for someone…", `.c-mono.c-muted` `var(--fs-xs)` "usually under 8s".
- **Right tile**: user's video, name pill "You · they'll see this".
- Bottom-right: full-height `.c-btn.c-btn--secondary.c-btn--lg` **Cancel search**, then the 34px row with
  mic, camera, a small **"Report last"** text button (`var(--fs-xs)`, `var(--text-muted)`, 11px red flag SVG,
  no background/border) and `.c-btn--secondary.c-btn--sm` "Edit interests".
- **"Report last" is visible only for 10s after the user skips**, then it disappears.

### 4. Chat page — state C: connected (design ref `2b`)
- Status bar centre: `.c-badge.c-badge--online` with `.c-dot.c-dot--live` + "Connected · 00:42" (live timer).
- Stranger tile: video, name pill with live dot ("Priya"), red flag report button top-right.
- Chat log shows real messages; message bar enabled, placeholder "Message Priya…".
- Bottom-right buttons, `grid-template-columns:2fr 1fr`:
  - **Skip** — `.c-btn.c-btn--lg`, primary fill, `height:100%`, `font-size:var(--fs-xl)`. (Label is "Skip", not "Next".)
  - **Stop** — same size, **soft red**: `background:var(--danger-tint); color:var(--danger); border-color:var(--danger-tint); box-shadow:none`.
  - Below: mic + camera + `.c-help` "Skip is instant — no goodbye needed."
- There is **no Block button** in the control bar; blocking happens via the report dialog.

### 5. Chat page — report dialog (design ref `2c`)
Modal over the live screen (video keeps running behind, backdrop `var(--scrim)`, content behind at
`blur(1px); opacity:.5`). `.c-modal__sheet`, 460px:
- `.c-h3` "Report Priya" + `.c-body.c-muted`: "They're disconnected right away and you won't be matched
  again. A moderator reviews this, usually within the hour."
- Reason `.c-chip`s (single-select): Nudity · Harassment · Under 18 · Spam or scam · Something else.
- Optional `.c-textarea` (2 rows), label "Anything to add? optional", placeholder "What happened?".
- `.c-modal__actions`: `.c-btn.c-btn--ghost` Cancel + `.c-btn.c-btn--danger-solid` "Report & block".
- Success feedback: `.c-toast.c-toast--success` "Reported. You won't be matched with them again."

---

## Interactions & behaviour

| Trigger | Result |
|---|---|
| Landing "Start chatting" | Navigate to chat page in **idle** state; request camera/mic permission. |
| Idle → **Start** | State → searching; open socket, join queue with selected interests/country/language. |
| Searching → match found | State → connected; start timer; enable message bar; focus it. |
| Connected → **Skip** | Tear down peer, state → searching, clear chat log, start the 10s "Report last" window. |
| Connected → **Stop** | Tear down peer, leave queue, state → idle. |
| Stranger disconnects | Same as Skip but show a one-line notice in the chat panel (state not yet designed — open item). |
| Report flag / "Report last" | Open report modal for that session id. On submit: disconnect + block, show success toast. |
| Mic / camera icon buttons | Toggle local tracks; `.c-iconbtn--active` when ON, plain `.c-iconbtn` when muted/off. |
| Chip click | Toggle `.is-selected`; re-queue if currently searching. |

Motion: transitions use `var(--dur-fast)`/`var(--dur-base)` with `var(--ease)`; the only animations are the
`.c-spinner` rotation and the `.c-dot--live` pulse. `prefers-reduced-motion` disables both (already in `clarity.css`).
No glows, no gradients, no bounce.

## State management

```
callState:  'idle' | 'searching' | 'connected'
peer:       { sessionId, displayName, hasVideo } | null
elapsed:    seconds since match (drives "Connected · 00:42")
messages:   [{ from:'me'|'peer', text, at }]   // cleared on skip/stop, never persisted
interests:  string[]        // chips, persisted locally
country, language: string   // chips, persisted locally
localMedia: { micOn: boolean, camOn: boolean }
lastPeer:   { sessionId, displayName, endedAt } | null   // drives "Report last"
reportOpen: false | { sessionId, reason, note }
```

**"Report last" requirement (backend):** on disconnect, keep the ended session's id — and ideally its chat
log / a short recording — server-side for a grace window (≥10s for the UI, longer if you add a recent-people
list later) so a post-skip report is actionable. Report payload: `{ sessionId, reason, note }`.

## Design tokens
All from `clarity.css` (included). Dark-stage values used here:

- Surfaces: `--bg #0d1117`, `--surface #161b22`, `--surface-2 #21262d`
- Borders: `--border rgba(255,255,255,.10)`, `--border-strong rgba(255,255,255,.20)`
- Text: `--text #f0f3f8`, `--text-muted #aab2c0`, `--text-subtle #6b7482` (decorative only)
- Brand: `--primary #6d63ff` (hover `#8078ff`, active `#5a50f0`), `--primary-tint rgba(109,99,255,.18)`
- Semantic: `--online #3fcf6b`, `--danger #fb5f7a`, `--warning #f0a92e`, each with a `-tint`
- Radius: `--r-sm 6` · `--r-md 10` · `--r-lg 16` · `--r-pill`
- Space: `--s-1…--s-8` = 4·8·12·16·24·32·48·64
- Type: Inter; `--fs-xs 12 · --fs-sm 14 · --fs-md 16 · --fs-lg 20 · --fs-xl 26 · --fs-2xl 36 · --fs-3xl 52`;
  weights 400/500/600. Mono: JetBrains Mono for timers/counts.
- Elevation: `--shadow-sm/md/lg`; focus ring `--ring`.
- Accessibility: keep tap targets ≥34px in the compact rows and ≥44px elsewhere; `--text-subtle` never
  carries essential content; every interactive element keeps its `:focus-visible` ring.

## Assets
No image assets. The logo is a placeholder rounded square — swap in the real mark. The shield and flag are
inline SVGs (in the reference HTML, copy verbatim). Mic/camera/settings currently use emoji glyphs
(🎙 📷 ⚙) — replace with your icon set. Inter and JetBrains Mono load from Google Fonts via `clarity.css`;
self-host for production.

## Open items
- **Product name/tagline** — "Openline" is a placeholder used throughout.
- **Stranger-leaves-first state** — not designed yet.
- **Mobile layout** — desktop only so far; the 1fr 1fr grids need to stack.
- A "recent people" list (report someone hours later) was proposed and deferred.

## Files
- `chat-page-reference.html` — the design reference: idle, searching, connected and report states.
- `clarity.css` — the Clarity design system stylesheet, production-ready.
- `screens/01-idle.png` · `02-searching.png` · `03-connected.png` · `04-report.png` — 2× screenshots of each state, 1280px design width.
