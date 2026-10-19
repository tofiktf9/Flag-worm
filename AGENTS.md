# AGENTS.md — Flag Worm (دودة الأعلام)

Multiplayer slither-style browser game (Arabic, RTL). **Deployed on Render**, not Netlify: it needs a long-running Node server with a raw WebSocket (`/ws`, 20 ticks/s) and Postgres (`DATABASE_URL`). `netlify.toml` only publishes `public/` so server files and `data/secret` hashes are never exposed.

## Layout
- `server.js` — Express API + hand-written WebSocket server (no ws library). Sections: auth/sessions, economy (`/api/buy`, `/api/run/*`), gift codes, payments (Chargily / Lemon Squeezy), multiplayer rooms, **boss**, **party**, **chat**, **DMs** (`/api/dm`, `/api/user/:id`). Tables are created in `init0()` with `create table if not exists` (no migration tool).
- `logic.js` — pure economy rules (tested by `node test.js`). `EMOJIS` list + `prefs()` (saves `st.emo`, the user's 1–9 emoji slots).
- `catalog.json` — skins/flags/prices.
- `public/index.html` — the whole original client, minified-style single file. Keep edits there minimal.
- `public/social.js` — boss rendering/collision, minimap + party arrows, chat panel (global / party / DM), party UI, emoji slots and in-game emotes. Loaded after the main script; it reuses its globals (`G`, `S`, `WS`, `RM`, `TOKEN`, `wsSend`, `api`, `toast`, `esc`, `em`, `spr`, `FD`, `PX`, `W`, `c`) and wraps `wsConnect`, `wsMsg`, `addPeer`, `startS`, `logout`, `play1`.

## Hooks from index.html into social.js
`loop()` calls `bossLoop(dt)`; `draw()` calls `bossDraw(vx,vy)`, `emoDraw(s,r)` and `hudDraw(w,h)`; the keydown handler calls `typing(e)` / `socKey(e)`; `pushS()` sends `emo`.

## Non-obvious decisions
- Boss is server-simulated per room (`bossTick` in the 50 ms snapshot loop, sent as `snap.b`). Collisions are client-side like the rest of the game: player head on boss body → player dies; boss head on player body → client sends `bhit`, server validates distance + 500 ms cooldown, applies damage, rewards coins on kill via `tx()`.
- Boss respawn timestamp is persisted in `boss_state` so the 1-hour timer survives restarts/sleep. Constants must match: `BOSS` (server.js) ↔ `BZ` (social.js).
- WebSocket now connects right after login (not only when playing) so chat/DMs/invites work in the lobby; it auto-reconnects. Lobby users sit in a room as `dead`.
- Parties live in memory (`PARTY`, `PARTY_OF`); members share `team='pt'` on the client, which the original collision code already uses to skip friendly kills. Joining prefers a party member's room.
- DMs are stored in `dms` and delivered live over WS when the recipient is online.
- Emoji lists must stay identical in `logic.js` (`EMOJIS`) and `social.js` (`EMJ`) — emotes are sent by index.
