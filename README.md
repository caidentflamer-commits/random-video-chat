# Random Video Chat — Prototype

A minimal, working "talk to a random stranger" video chat, like OmeTV or Monkey.
Two people get matched, see each other's live video, and can hit **Next** to
skip to someone new.

This is a learning/starting prototype. It has the real core (WebRTC video +
matchmaking) plus a **basic moderation layer**, but not the heavy production
pieces yet (a TURN server, accounts, database-backed bans, legal-grade abuse
detection). See "What's next" at the bottom.

## Moderation (what's built in)

- **Automatic camera check:** every few seconds, each person's browser scans
  their own camera with a free in-browser AI model (nsfwjs). If it detects
  explicit content, that person is disconnected with a warning. This runs on
  each user's own device, so it costs nothing to operate.
- **Report button:** during a call you can report the other person. That bans
  them (by IP) and disconnects them; they can't reconnect.
- **Fail-safe:** if the safety model can't load (e.g. a bad network), the app
  keeps working and the header shows "Safety check: off" instead of breaking.

You can tune how strict the auto-check is at the top of `public/index.html`
(the `EXPLICIT_THRESHOLD`, `SEXY_THRESHOLD`, and `TRIPS_BEFORE_ACTION` values).

Important honesty note: this is a *basic* layer meant for testing and small,
trusted groups. It is **not** enough to safely open to the general public — see
"What's next."

---

## What you need

Just one thing: **Node.js**. If you don't have it:

1. Go to https://nodejs.org
2. Download the big green **"LTS"** button and install it (click through the defaults).
3. That's it — this also installs a command called `npm` that we use below.

---

## How to run it (about 3 steps)

1. **Open a terminal in this folder.**
   - **Windows:** open this folder in File Explorer, click the address bar,
     type `cmd`, and press Enter.
   - **Mac:** right-click the folder → "New Terminal at Folder"
     (or open Terminal and drag the folder onto it).

2. **Install the one dependency** (only needed the first time). Type this and press Enter:

   ```
   npm install
   ```

3. **Start it up:**

   ```
   npm start
   ```

   You'll see a message like `Open this in your browser: http://localhost:3000`.

---

## How to test it by yourself

You need two "people" to see a match. The easiest way to test alone:

1. Open **http://localhost:3000** in your browser and click **Start**
   (allow camera + microphone when asked).
2. Open the **same address in a second tab** (or a second browser window) and
   click **Start** there too.

The two tabs will match with each other, and you'll see your camera in both
the "You" and "Stranger" boxes. Click **Next** in either tab to re-match.

> Testing with a friend on another computer needs one extra step (HTTPS + a
> public address). That's covered in "What's next" below — the two-tab test is
> the quickest way to confirm everything works.

---

## What each file does

- **server.js** — the "matchmaker." Serves the web page, pairs up waiting
  users, and passes the connection-setup messages between each pair. It never
  sees your video; that goes browser-to-browser.
- **public/index.html** — everything you see and click: the camera, the video
  boxes, the Start/Next buttons, and the WebRTC logic.
- **package.json** — lists the one dependency (`ws`, for the live connection).

Both main files are heavily commented, so they're a good place to poke around
and learn how it works.

---

## What's next (turning this into a real product)

In rough order of importance:

1. **Deploy it** so it has a public web address and HTTPS (required for the
   camera to work for remote users). **See `DEPLOY.md`** — it has click-by-click
   steps for both a quick 5-minute test with a friend and a permanent free
   host (Render).
2. **Add a TURN server** so people on strict networks can still connect. Right
   now it only uses a free STUN server, which works for most — but not all —
   connections.
3. **Upgrade moderation for a public launch.** The built-in basic layer (see
   above) is enough for testing and trusted groups, but a real public launch
   needs more: bans stored in a database (so they survive restarts), stronger
   server-side detection, device fingerprinting so bans stick, and — legally
   required — specialized detection/reporting for illegal content (e.g. CSAM
   via services like PhotoDNA or Thorn). This tier involves ongoing cost and
   legal obligations, not just code.
4. **Add the money features** later: gender/region filters, skip-the-wait, or
   remove-ads as a paid upgrade.

Have fun with it.
