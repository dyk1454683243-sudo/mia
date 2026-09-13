# Mia — multiplayer dice bluffing game on Cloudflare

Implementation spec. This is written to be executed cold: everything needed is here,
including the exact ruleset, the Cloudflare platform constraints, and the gotchas that
would otherwise cost debugging time.

## Context

Build a browser-based, phone-first multiplayer implementation of **Mia**, the German dice
bluffing game ([rules](https://en.wikipedia.org/wiki/Mia_(game))), from an empty repo.

Requirements from the user:

- Responsive UI. Most play happens on a phone browser.
- Cloudflare backend, restricted to services that work on a **temporary account**
  (Workers, Static Assets, D1, Durable Objects). **R2, Workers AI, Vectorize, Queues-heavy
  designs and Containers are unavailable** — do not design around them.
- No signup. A player is created automatically on first visit and tracked by cookie.
  Losing the cookie means starting over — acceptable, this is low stakes. Default name is
  a ship name from Iain M. Banks' Culture novels, renameable. Player records live in D1.
- Lobby lists tables waiting for players and allows creating a named table; tables live
  in D1.
- A table has a shareable direct-join link that bypasses the lobby. Each table is its own
  Durable Object. **Only final game results are written to D1** — live game state never
  touches it.

Decisions already made with the user, do not re-litigate:

- **Plain core ruleset only** — no "pass/relay the cup", no "accept a Mia without
  revealing", no "rolling your own Mia ends the round".
- **Vanilla TypeScript + Vite** frontend. No React/Preact.
- **60-second turn timer with server auto-play** on expiry (not forfeit, not untimed).
- Final step is `wrangler deploy --temporary` with live verification, and handing the user
  the live URL plus the claim URL.

## Current repo state

Already created (keep or adjust as needed):

- `package.json` — scripts `build` / `dev` / `test` / `typecheck` / `deploy`, devDeps
  `wrangler ^4.131.1`, `vite ^6`, `vitest ~3.0`, `@cloudflare/vitest-pool-workers ^0.9`,
  `concurrently`, `typescript`. **`npm install` has not been run yet.**
- `.gitignore` — `node_modules/`, `dist/`, `.wrangler/`, `.cfstate/`, `.dev.vars`,
  `.DS_Store`, `worker-configuration.d.ts`.
- `README.md` — empty, needs writing.
- `.agents/skills/` — Cloudflare skill docs (durable-objects, workers-best-practices,
  wrangler, cloudflare-temporary-accounts). Worth reading; the key points are summarized
  below.

Local toolchain verified: Node v26.8.2, npm 11.19.1, wrangler 4.131.1, and the machine is
**logged out of Cloudflare** — which is what `--temporary` requires.

## Ruleset to implement

- 6 lives each. 2–8 players per table; 2 minimum to start.
- A roll's value is **higher die × 10 + lower die**, not a sum.
- Ranking, highest to lowest — hardcode this order, do not compute it:

  ```
  21, 66, 55, 44, 33, 22, 11, 65, 64, 63, 62, 61, 54, 53, 52, 51, 43, 42, 41, 32, 31
  ```

  `21` is **Mia** and unbeatable. Doubles outrank all mixed rolls.
- Round flow: the starter rolls in secret and announces **any** value (truth or bluff).
  Each following player either:
  - **believes** — takes the cup, rolls blind, and must then announce a value **strictly
    higher** than the standing announcement (so a low roll forces a bluff); or
  - **doubts** — calls the previous player a liar and reveals that player's actual dice.
- Resolution of a doubt:
  - actual **<** announced (bluff caught) → the **announcer** loses 1 life;
  - actual **≥** announced → the **doubter** loses 1 life;
  - the announcement was Mia **and** the dice really are 21 → the **doubter loses 2**.
- The player who lost the life starts the next round (the next living player after them if
  that loss eliminated them).
- A player at 0 lives is out. Last player standing wins.
- Turn timer: 60 seconds per decision. On expiry the server plays the safest legal move
  for the idle player — **doubt** when Mia stands or when no legal higher announcement
  exists, otherwise **believe** and announce the minimum legal value. The game must never
  stall on a dropped phone.

Put ranking, legal-move generation and the entire state machine in one **pure** module
with no Cloudflare imports, so it is unit-testable in plain vitest.

## Architecture

```
browser ──HTTP──► Worker ──► D1          (identity, table directory, finished games)
   │                 │
   │                 └──► TableRoom DO    (one per table: live game state, WebSockets)
   └──WebSocket──────────►
```

- **Worker** (`src/worker/index.ts`) serves static assets, the JSON API, and proxies
  WebSocket upgrades into the table's Durable Object.
- **TableRoom DO** (`src/worker/table-room.ts`) owns all live game state, one instance per
  table via `env.TABLE.getByName(tableId)`. It uses the **WebSocket Hibernation API** —
  `this.ctx.acceptWebSocket(server, [playerId])`, handlers `webSocketMessage(ws, msg)` /
  `webSocketClose(ws, code, reason, wasClean)` / `webSocketError(ws, err)`, and
  `ws.serializeAttachment({ playerId })` / `ws.deserializeAttachment()` to survive
  hibernation — so idle tables cost nothing. `this.ctx.getWebSockets()` enumerates live
  connections for broadcast.
- Turn timer and reveal pacing use `this.ctx.storage.setAlarm()`. **One alarm per DO** —
  `setAlarm` replaces any existing alarm, so keep a single "next deadline" and recompute
  it after every state change.
- Persist state with `this.ctx.storage.put("room", state)` (a single key, so the write is
  atomic) and cache it in memory; load it in the constructor under
  `ctx.blockConcurrencyWhile()`. Persist before updating in-memory state. Never hold
  `blockConcurrencyWhile` across network I/O.
- When a game ends, the DO writes the result rows to D1 through `this.env.DB` (bindings are
  reached via `this.env` inside a DO, never a bare `env`).

### Routing — avoids the static-assets traps

Use **no SPA fallback** and **no `run_worker_first`**. Two real HTML entry points:

- `/` → `index.html` (lobby), served directly by the asset binding.
- `/t/:tableId` → not a file in the assets directory, so it reaches the Worker, which
  returns `env.ASSETS.fetch(new URL("/table.html", request.url))`. This is the shareable
  join link; the client reads the id from `location.pathname`.
- Guard the API on **both** forms, because `startsWith("/api/")` alone silently hands the
  bare `/api` path to the asset binding:

  ```ts
  const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
  if (!isApi && !url.pathname.startsWith("/t/")) return env.ASSETS.fetch(request);
  ```

Setting `not_found_handling: "single-page-application"` would return `index.html` with
HTTP 200 for every unmatched path, including API routes. Do not set it.

### Identity

Cookie `mia_pid` = `<playerId>.<base64url(HMAC-SHA256(playerId, key))>`, with `HttpOnly`,
`SameSite=Lax`, `Path=/`, `Secure` (omitted on localhost so local dev works), and
`Max-Age` 400 days. Verify with a **constant-time** compare, not `===`.

The HMAC key is generated once with `crypto.getRandomValues` and stored in a D1
`app_config` row, cached per isolate. This avoids provisioning a secret, which keeps the
temporary deploy a single command. Use `crypto.randomUUID()` for player and table ids —
never `Math.random()` for anything identifying.

Missing or invalid cookie → create a player row with a random Culture ship name and set
the cookie on the response. Every HTML and API response path must be able to mint one.

### D1 schema

There is no migration step on free-tier D1. Create tables lazily from an
`ensureSchema(env)` helper that caches its promise per isolate **and resets the cache on
failure**, or a transient error poisons the isolate for its lifetime:

```ts
let schemaReady: Promise<unknown> | null = null;
export function ensureSchema(env: Env) {
  schemaReady ??= env.DB.batch([...]).catch((err) => { schemaReady = null; throw err; });
  return schemaReady;
}
```

| Table | Columns | Purpose |
| --- | --- | --- |
| `app_config` | `key` PK, `value` | session signing key |
| `players` | `id` PK, `name`, `created_at`, `last_seen_at` | identity |
| `tables` | `id` PK, `name`, `host_id`, `status`, `player_count`, `max_players`, `created_at`, `updated_at` | lobby directory; `status` ∈ `waiting` \| `playing` \| `finished` \| `abandoned` |
| `games` | `id` PK, `table_id`, `table_name`, `started_at`, `finished_at`, `winner_id`, `winner_name` | final results only |
| `game_players` | `(game_id, player_id)` PK, `name`, `place`, `lives_left`, `rounds_played` | per-player results |

The DO updates its own `tables` row on join / leave / start / finish so the lobby listing
stays accurate. Index `tables(status, updated_at)` for the lobby query.

### HTTP API

| Route | Behavior |
| --- | --- |
| `GET /api/me` | current player `{id, name}`, creating one if needed |
| `PATCH /api/me` | rename — trim, strip control characters, require 1–40 chars, else 400 |
| `GET /api/tables` | open and in-progress tables with player counts |
| `POST /api/tables` | create a named table, returns `{id}` |
| `GET /api/tables/:id` | table metadata for the direct-join page; 404 if unknown |
| `GET /api/tables/:id/ws` | WebSocket upgrade, proxied to the DO |
| `GET /api/history` | recent finished games from D1 |

Return 405 for wrong methods and 400 for malformed bodies — these get exercised during
verification.

For the upgrade, check `request.headers.get("Upgrade") === "websocket"`, resolve the
player from the cookie, then hand off to the DO stub, passing the player id and name (for
example as internal request headers the DO reads). The DO replies with HTTP 101.

### WebSocket protocol

Client → server: `start`, `roll`, `announce {value}`, `believe`, `doubt`, `leave`.

Server → client: a full `state` snapshot after every change, **redacted per socket** — a
player's dice are sent only to that player until a reveal makes them public. Include a
rolling event log and the absolute turn-deadline timestamp so clients can render a
countdown without their own clock drift mattering much.

Because broadcasts are per-socket redacted, build the snapshot per recipient rather than
once; `ctx.getWebSockets()` plus each socket's attachment gives you the recipient id.

Put message and state shapes in a shared module imported by both the Worker and the
browser bundle so the contract is typechecked on both sides.

Reject illegal actions server-side with an `error` message rather than trusting the
client: wrong player's turn, wrong phase, an announcement that is not strictly higher, a
roll value that is not in the ranking table.

## Files

```
package.json  tsconfig.json  vite.config.ts  wrangler.jsonc  .gitignore  README.md
src/shared/mia.ts        # ranking, legal moves, pure state machine   ← core logic
src/shared/protocol.ts   # WS message + state types (client & server)
src/shared/ships.ts      # Culture ship-name pool
src/worker/index.ts      # routes, asset fallback, exports TableRoom
src/worker/session.ts    # cookie sign/verify, ensurePlayer
src/worker/db.ts         # ensureSchema + D1 queries
src/worker/table-room.ts # TableRoom Durable Object
client/index.html  client/table.html
client/src/lobby.ts  client/src/table.ts  client/src/net.ts  client/src/styles.css
test/mia.test.ts  test/room.test.ts
```

Vite builds the two client pages (multi-page `rollupOptions.input`) from `client/` into
`dist/client`; Wrangler serves that directory via the `assets` binding. Keeping the Vite
build and the Wrangler deploy as separate steps — rather than using the Cloudflare Vite
plugin — keeps `wrangler deploy --temporary` behaving exactly as documented.

`wrangler.jsonc`:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "mia",
  "main": "src/worker/index.ts",
  "compatibility_date": "2026-09-12",
  "assets": { "directory": "./dist/client", "binding": "ASSETS" },
  "durable_objects": { "bindings": [{ "name": "TABLE", "class_name": "TableRoom" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["TableRoom"] }],
  // database_name but NO database_id, so a temporary account auto-provisions it
  "d1_databases": [{ "binding": "DB", "database_name": "mia-db" }],
  "observability": { "enabled": true, "traces": { "enabled": true } }
}
```

`new_sqlite_classes` is what makes Durable Objects usable on the free plan. `TableRoom`
must be **exported from the Worker entrypoint** (`export { TableRoom } from "./table-room";`)
— a class exported only from a non-entry module will not deploy. Generate types with
`wrangler types` after any config change rather than hand-writing `Env`; `observability.enabled`
alone does not turn on traces, the nested flag is required.

## UI

Mobile-first, single column, thumb-reachable controls, dark table-felt palette, no
framework — a small render function over the last state snapshot.

- **Lobby**: your name (tap to edit inline), a list of open tables with player counts and
  a Join button, a "New table" form, and a collapsed recent-results list from
  `/api/history`. Poll `/api/tables` every few seconds; no WebSocket needed here.
- **Table**: players as cards showing name, lives as pips, and who holds the cup; the
  standing announcement large and central; your own dice visible only to you; a countdown
  on the active player. The action area swaps by phase — `Roll`, an announce grid where
  only values above the standing announcement are tappable (with a distinct Mia button),
  or `Believe` / `Doubt`. Reveals show the actual dice beside what was claimed with a
  one-line verdict. A Share button copies the `/t/:id` link, using `navigator.share` where
  available.

Handle the reconnect case: a client that refreshes or returns from background reconnects
and receives the current snapshot, with no visible difference from never having left.

## Verification

1. `npm install`, then `npm run test` — vitest.
   - `test/mia.test.ts`: the full ranking order; that only strictly-higher announcements
     are legal; all three doubt outcomes including the 2-life Mia penalty; who starts the
     next round; elimination and win detection.
   - `test/room.test.ts`: `@cloudflare/vitest-pool-workers` driving a TableRoom through
     join → start → a bluff caught → game over, asserting the D1 result rows.
2. `npx wrangler types` then `tsc --noEmit`, both clean.
3. Local end-to-end with `npm run dev` (Vite watch + `wrangler dev`). Drive player 1 in a
   browser at a phone viewport (375×812); drive players 2 and 3 with a small Node script
   that fetches its own cookie from `/api/me` and plays over the WebSocket. Confirm: lobby
   listing, create and join by link, **hidden dice** (player 2 never receives player 1's
   dice before a reveal), a caught bluff, a failed doubt, the Mia double penalty,
   elimination, game over, and the resulting rows via `wrangler d1 execute --local`.
4. Turn timer: let a turn expire, confirm the server auto-plays and the game continues.
   Reconnect a client mid-game and confirm state is restored from the DO.
5. `npx wrangler deploy --temporary`. Run it **non-interactively, in one shot, as a
   background job** — the proof-of-work step takes minutes and there is no prompt to
   answer. Then exercise the live URL: `/`, `/t/:id`, every API route, a 404 for a missing
   table, a 400 for an invalid rename, a 405 for a wrong method. A Cloudflare error page
   (e.g. `error code: 1042`) in the first seconds after deploy is edge propagation, not a
   bug — retry before debugging.
6. **Redeploy once** into the same cached temporary account (it reports the account as
   `(reused)` and bindings as `(inherited)`) and confirm D1 rows and DO state survive.
   Temporary account creation is rate limited, so never burn a second account by running
   `wrangler login`/`logout` mid-iteration.
7. Read `wrangler.jsonc` after the first deploy and strip any provisioned resource IDs
   auto-provisioning may have written back before committing.

## Handing over

Give the user, in chat and never in a committed file or an artifact:

1. The live `workers.dev` URL.
2. The claim URL, framed as a bearer credential, with the deadline in absolute UTC time.
3. That an unclaimed account and all its resources are deleted.
4. What was actually verified and what was not.

## Notes

- Dice use `crypto.getRandomValues`, never `Math.random()`.
- If Wrangler's global config directory is not writable (sandboxed runs), the deploy fails
  *after* the proof-of-work. `WRANGLER_HOME` is not supported; relocate with
  `XDG_CONFIG_HOME=./.cfstate XDG_CACHE_HOME=./.cfstate/cache npx wrangler deploy --temporary`.
  That directory holds the account id, API token and claim URL — it is already gitignored;
  never commit, log, or display it.
- Do not commit account-specific IDs.
