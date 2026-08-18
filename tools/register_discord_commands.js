#!/usr/bin/env node
/*
 * Registers Olumie's slash commands with Discord. Run once, and again whenever
 * the list below changes — Discord stores them, the server does not.
 *
 *   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node tools/register_discord_commands.js
 *
 * Global commands can take up to an hour to appear. To iterate faster, pass a
 * guild id and they register instantly for that one server:
 *
 *   ... DISCORD_GUILD_ID=... node tools/register_discord_commands.js
 *
 * Nothing here touches the running app; the token is read from the environment
 * and never written anywhere.
 */

const APP = process.env.DISCORD_APP_ID;
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD = process.env.DISCORD_GUILD_ID;

if (!APP || !TOKEN) {
  console.error('Set DISCORD_APP_ID and DISCORD_BOT_TOKEN. Both are on the app page at discord.com/developers/applications.');
  process.exit(1);
}

const COMMANDS = [
  { name: 'stats', description: 'Live numbers: online, page loads, matches, reports, bans, queue depth', type: 1 },
  { name: 'queue', description: 'Repost the waiting reports as cards you can act on', type: 1 },
  { name: 'whoami', description: 'What the server thinks a visitor IP looks like (proxy hop check)', type: 1 },
];

const url = GUILD
  ? `https://discord.com/api/v10/applications/${APP}/guilds/${GUILD}/commands`
  : `https://discord.com/api/v10/applications/${APP}/commands`;

fetch(url, {
  method: 'PUT',                        // PUT replaces the whole set, so removals take effect too
  headers: { 'Content-Type': 'application/json', Authorization: `Bot ${TOKEN}` },
  body: JSON.stringify(COMMANDS),
})
  .then(async (r) => {
    const text = await r.text();
    if (!r.ok) { console.error(`Failed (${r.status}): ${text}`); process.exit(1); }
    const list = JSON.parse(text);
    console.log(`Registered ${list.length} command(s) ${GUILD ? `in guild ${GUILD}` : 'globally (allow up to an hour to appear)'}:`);
    list.forEach((c) => console.log(`  /${c.name} — ${c.description}`));
  })
  .catch((e) => { console.error('Request failed:', e.message); process.exit(1); });
