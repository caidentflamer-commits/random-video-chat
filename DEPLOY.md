# Getting it online (so a friend can join)

Right now the app only works on your own computer (`localhost`). To let a
friend on another computer connect, it needs a **public web address with
HTTPS** — the camera won't turn on for remote users without HTTPS.

There are two ways to do this. Pick based on what you want:

- **Option A — Test with a friend in ~5 minutes** (temporary, runs from your computer).
- **Option B — Put it online for real** (a permanent free web address). Recommended once you're happy with it.

---

## Option A — Quick test with a friend (temporary)

This keeps the app running on your computer and just opens a temporary public
"tunnel" to it. Good for a quick "does this actually work with a real second
person" test.

1. Start the app as usual (in the project folder):

   ```
   npm install
   npm start
   ```

   Leave that terminal running.

2. Open a **second** terminal in the same folder and run:

   ```
   npx localtunnel --port 3000
   ```

   The first time, it may ask to install — say yes. It will print a public
   URL like `https://something.loca.lt`.

3. Open that URL yourself and click **Start**. Send the same URL to your
   friend. When you both click Start, you'll be matched.

   - localtunnel may show a one-time "click to continue" page asking for a
     password — the password shown on that page is your public IP, which the
     page tells you how to find. Just follow its instructions once.

That's it. The tunnel and matches only work while your `npm start` terminal
stays open. Close it and the public URL stops.

> If localtunnel gives you trouble, `ngrok` is a popular alternative — it
> works the same way but needs a quick free signup for a token.

---

## Option B — Put it online for real (free, no command line)

This hosts the app on **Render's** free tier. It stays online on its own, has
a proper `https://…onrender.com` address, and you don't need your computer
running. It's free (no credit card). The only quirk: after 15 minutes with no
visitors it "sleeps," and the next visit takes about a minute to wake up.

You'll do this entirely in your web browser — no terminal, no `git`.

### Step 1: Put the code on GitHub (drag-and-drop, no git needed)

1. Make a free account at https://github.com if you don't have one.
2. Click the **+** at the top-right → **New repository**.
3. Give it a name like `random-video-chat`, leave it **Public**, and click
   **Create repository**.
4. On the new empty repo page, click the **"uploading an existing file"**
   link.
5. Drag **all the files from this project folder** into the browser
   (server.js, package.json, package-lock.json, render.yaml, the `public`
   folder, etc.). You do **not** need to upload `node_modules`.
6. Click **Commit changes**.

### Step 2: Deploy it on Render

1. Make a free account at https://render.com (you can sign in with your
   GitHub account — easiest).
2. Click **New +** → **Blueprint**.
3. Connect your GitHub and pick the `random-video-chat` repo you just made.
   Render will read the included `render.yaml` and fill in everything for you.
4. Click **Apply** / **Create**. Wait a couple of minutes while it builds.
5. When it's done, Render gives you a public address like
   `https://random-video-chat.onrender.com`.

### Step 3: Use it

Open that address, click **Start**, and share the link with anyone. Two
people who open it and click Start get matched — from anywhere.

> Prefer not to use a Blueprint? You can instead click **New + → Web Service**,
> pick the repo, and set **Build Command** to `npm install` and **Start
> Command** to `npm start`. Same result.

---

## After it's online

Once real strangers (not just you and a friend) can reach it, the next
priority is **moderation** — it's what keeps the app legal and usable, and
it's the thing to build before promoting the link anywhere public. The main
README lists the full "what's next" order.
