#!/usr/bin/env node
/*
 * Says exactly why a card is not showing up.
 *
 *   DISCORD_BOT_TOKEN=... DISCORD_CHANNEL_ID=... node tools/discord_selftest.js
 *
 * (PowerShell: $env:DISCORD_BOT_TOKEN="..."; $env:DISCORD_CHANNEL_ID="..."; node tools/discord_selftest.js)
 *
 * Checks the three things that can independently be wrong — the token, access
 * to the channel, and permission to post components — and prints Discord's own
 * error rather than a guess. The token is read from the environment and is
 * never written anywhere.
 */

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL = process.env.DISCORD_CHANNEL_ID;
const API = 'https://discord.com/api/v10';

if (!TOKEN || !CHANNEL) {
  console.error('Set DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID (the same values you put on Render).');
  process.exit(1);
}

const auth = { Authorization: `Bot ${TOKEN}` };
const CHANNEL_KINDS = { 0: 'text', 1: 'DM', 2: 'voice', 5: 'announcement', 11: 'public thread', 12: 'private thread', 15: 'forum' };

async function step(label, fn) {
  process.stdout.write(`${label.padEnd(34)}`);
  try { const out = await fn(); console.log(out.ok ? `OK   ${out.detail || ''}` : `FAIL ${out.detail || ''}`); return out; }
  catch (e) { console.log(`FAIL ${e.message}`); return { ok: false }; }
}

(async () => {
  const me = await step('1. token valid?', async () => {
    const r = await fetch(`${API}/users/@me`, { headers: auth });
    if (r.status === 401) return { ok: false, detail: '401 — the token is wrong or was reset. Copy it again from the Bot tab and update Render too.' };
    if (!r.ok) return { ok: false, detail: `${r.status} ${(await r.text()).slice(0, 120)}` };
    const u = await r.json();
    return { ok: true, detail: `bot is ${u.username} (${u.id})` };
  });
  if (!me.ok) process.exit(1);

  const ch = await step('2. can the bot see the channel?', async () => {
    const r = await fetch(`${API}/channels/${CHANNEL}`, { headers: auth });
    if (r.status === 404) return { ok: false, detail: '404 — no such channel. Most often this is a SERVER id pasted instead of a CHANNEL id: right-click the channel itself, not the server name.' };
    if (r.status === 403) return { ok: false, detail: '403 — the bot is not in that server, or cannot view that channel. Re-run the OAuth2 invite URL (scopes: bot + applications.commands), and check the channel is not private to roles the bot lacks.' };
    if (!r.ok) return { ok: false, detail: `${r.status} ${(await r.text()).slice(0, 160)}` };
    const c = await r.json();
    const kind = CHANNEL_KINDS[c.type] || `type ${c.type}`;
    if (![0, 5, 11, 12].includes(c.type)) return { ok: false, detail: `it is a ${kind} channel — cards need a text channel.` };
    return { ok: true, detail: `#${c.name} (${kind})` };
  });
  if (!ch.ok) process.exit(1);

  await step('3. can it post a card?', async () => {
    const r = await fetch(`${API}/channels/${CHANNEL}/messages`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: 'Self-test',
          description: 'If you can see this with two buttons below it, posting works. The buttons do nothing — delete this message.',
          color: 0x2b2f3a,
        }],
        components: [{ type: 1, components: [
          { type: 2, style: 4, label: 'Ban this IP', custom_id: 'selftest:noop:1', disabled: true },
          { type: 2, style: 2, label: 'Dismiss', custom_id: 'selftest:noop:2', disabled: true },
        ] }],
      }),
    });
    if (r.status === 403) return { ok: false, detail: '403 — the bot can see the channel but cannot Send Messages in it. Fix the channel permissions or the bot role.' };
    if (!r.ok) return { ok: false, detail: `${r.status} ${(await r.text()).slice(0, 200)}` };
    return { ok: true, detail: 'posted — go look at the channel' };
  });

  console.log('\nIf all three passed, posting is fine and the problem is elsewhere:');
  console.log('  - DISCORD_CHANNEL_ID on Render may differ from the one you just tested with');
  console.log('  - Render may not have redeployed since you set the variables');
  console.log('  - check the Render logs for a line starting "discord send failed"');
})();
