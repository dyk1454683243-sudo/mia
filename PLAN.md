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

---

# Remaining work — handoff tasks

## Status board

Keep this current as tasks land — it is the one place to look for what is left.
A task is **Done** only once it has been reviewed.

| Task | Status | Notes |
| --- | --- | --- |
| R1 — browser verification at a phone viewport | Open | Also delivers `scripts/bots.ts` |
| R2 — `README.md` | Open | |
| R3 — `wrangler deploy --temporary` | Open | Blocked on R1, R2, B2–B5 |
| R4 — verify the live URL | Open | Blocked on R3 |
| R5 — redeploy, prove persistence | Open | Blocked on R4 |
| R6 — config hygiene, hand-over report | Open | Blocked on R5 |
| B1 — abandoned-table alarm loop | **Done** — `ea28513`, reviewed | Follow-ups in B11 |
| B2 — finishing places from seat order | **Done** — `07fb73e`, reviewed | |
| B3 — lost result write | **Done** — `eb8d1db`, reviewed | Follow-ups in B10, B11 |
| B4 — frozen turn countdown | **Done** — `c0f396b`, reviewed | Re-render note in R1 |
| B5 — host tab-close bricks the table | Open | Pre-deploy |
| B6 — duplicate redaction implementations | Open | |
| B7 — session key creation race | Open | |
| B8 — client replays stale actions | Open | |
| B9 — test seams on the production DO | Open | |
| B10 — minor cleanup pass | Open | |
| B11 — residual alarm-scheduling gaps | Open | Raised by the B1 review |

Status as of commit `1a9bb09`. Everything described above this section is built
and verified except the tasks below. Each is sized for one agent session and is
reviewable on its own.

Current state: 45 tests passing (39 unit + 6 workers), both typechecks clean,
`scripts/e2e.ts` 25/25 against `wrangler dev` across two full games. Nothing has
been deployed. The client has never been rendered in a browser.

## Ground rules for every task

- **Sandbox prefixes are mandatory.** `npm_config_cache=$PWD/.npm-cache` for npm,
  and `XDG_CONFIG_HOME=$PWD/.cfstate XDG_CACHE_HOME=$PWD/.cfstate/cache` for
  every `wrangler` command. Both paths are gitignored. See "Environment notes"
  in `progress.md`.
- **Never commit, log, echo, or paste into a file**: the claim URL, the
  temporary API token, the account ID, or anything under `.cfstate/`. The claim
  URL is a bearer credential — whoever holds it owns the account.
- Finish by updating `progress.md` (move the task out of "Not started", record
  what was verified and what was not) and committing.
- Report honestly. "I ran X and it passed" must mean exactly that; say plainly
  what was skipped or is still unknown.

## Sequencing

**B1–B5** (see "Code review findings" below) are code fixes and must land
before R3, alongside R1/R2 — B1 bills real money against a live account and B2
corrupts the only data the product persists.

**R1 and R2** are independent of each other and can run in either order, but
both must land before R3 — R3 deploys whatever is in the tree.

**R3 through R6 are time-coupled and should run back to back.** The claim URL
R3 produces expires **60 minutes** after it is created, and an unclaimed
account is deleted along with its D1 database and Durable Objects. Do not let
a review pause sit between them. The claim URL and its absolute UTC deadline
must reach the user **as soon as R3 finishes** — do not hold it back for the
R6 hand-over report.

---

## R1 — Verify the UI in a real browser at a phone viewport

**Why.** `client/src/lobby.ts` (239 lines), `client/src/table.ts` (379) and
`client/src/net.ts` (158) have never been rendered. Every verification so far is
protocol-level: the e2e harness speaks HTTP and WebSocket directly and never
loads the page. `vite build` succeeding proves the client compiles, not that it
works, and certainly not that it is usable on a phone — which is the primary
target.

**Deliverable first:** the harness plays all seats itself, so there is currently
no way to be a human player. Write `scripts/bots.ts` that joins N bot players to
an existing table id and plays them, reusing the `Client` class and
`chooseAction` from `scripts/e2e.ts` (extract the shared pieces rather than
copy-pasting them). Usage: `node scripts/bots.ts <tableId> [count]`.

**Then verify, at 375×812:**

1. **Lobby** (`/`): a ship name is shown; inline rename persists across a
   reload; the table list renders; creating a named table works; the 3-second
   poll (`client/src/lobby.ts:230`) refreshes without flicker, scroll jump, or
   losing focus in the rename field.
2. **Share** (`client/src/table.ts:81`): the `navigator.share` path and the
   `navigator.clipboard` fallback with its toast. Confirm the copied link is the
   `/t/:id` form and that opening it in a fresh session joins that table.
3. **A full game**, browser as one player and `scripts/bots.ts` as the others.
   Confirm every phase renders correctly: `roundStart`, `deciding`
   (Believe/Doubt), `announcing` (the announce grid, with values at or below the
   standing announcement non-tappable and Mia distinct), `revealing` (actual
   dice beside the claim, plus the verdict line), `finished` (winner).
4. **Secrecy in the UI**: your own dice appear only when you hold the cup; no
   other player's dice are ever on screen before a reveal.
5. **Reconnect**: background the tab and refresh mid-game; the socket's backoff
   reconnect (`client/src/net.ts:101`) should restore the live state with no
   duplicate seat.
6. **Phone fitness**: no horizontal scroll at 375px, tap targets comfortably
   thumb-sized, text legible without zoom, and a check at 768px that nothing
   collapses.
7. **The countdown** (`c0f396b`): confirm it visibly ticks down once a second
   through a whole turn, and that the once-per-second full-page re-render it now
   triggers is not perceptible — no flicker, no scroll jump, no tap landing on a
   replaced node, no interrupted animation. If it is perceptible, update the
   countdown's text node directly instead of calling `render()`.
8. **Console**: no errors or unhandled rejections at any point.

**Acceptance criteria.** Screenshots of the lobby, each of the five table
phases, and game over at 375×812. An explicit defect list with fixes applied, or
an explicit statement that no defects were found. Zero console errors.
`npx vitest run` still green and both typechecks clean. `scripts/bots.ts`
committed and working.

---

## R2 — Write README.md

**Why.** It is currently 0 bytes.

**Content.** What the game is and the exact ruleset implemented (the plain
ruleset — say so, and note which common variants were deliberately left out).
A short architecture summary and *why* a Durable Object per table. How to
install, run locally, and test. How to deploy. The project layout. The sandbox
environment prefixes.

**Acceptance criteria.** Someone who has never seen the repo can clone, install,
run, test, and deploy from the README alone. Every command in it must have been
actually run by the agent, not assumed. No account IDs, tokens, or claim URLs.

---

## R3 — Deploy to a temporary Cloudflare account

**Preconditions.** R1 and R2 landed; tests and typechecks green; the working
tree clean; `npx wrangler whoami` reports **not authenticated**.

**Do.**

1. Confirm wrangler >= 4.102.0 (installed: 4.131.1) and that no ambient
   credentials exist: `env | grep -iE 'cloudflare|cf_'`.
2. `npm run build`.
3. `XDG_CONFIG_HOME=$PWD/.cfstate XDG_CACHE_HOME=$PWD/.cfstate/cache npx wrangler deploy --temporary`
   — **as a background job, in one shot, non-interactively.** The
   proof-of-work step takes minutes; do not run it under a short timeout and do
   not answer prompts (continuing implies accepting the terms).
4. Capture the worker URL, the account name, the claim URL, and compute the
   deadline as deploy time + 60 minutes in **absolute UTC**.

**Hazards.** Do not run `wrangler login` or `logout` at any point — it clears
the cached account, and creating temporary accounts is rate limited. A
Cloudflare error page (e.g. `error code: 1042`) in the first seconds after
deploy is edge propagation, not a bug; retry before debugging.

**Acceptance criteria.** A live `workers.dev` URL that returns 200 for `/`. The
claim URL and its absolute UTC deadline delivered **in chat only**. The output
of `git status` and `git diff wrangler.jsonc` shown, since auto-provisioning may
write resource IDs back into the config. Nothing sensitive written to any file.

---

## R4 — Verify the deployed URL

**Do.**

1. Point the existing harness at the deployment:
   `MIA_BASE=https://<worker>.<account>.workers.dev node scripts/e2e.ts`.
   It already parameterises the base URL (`scripts/e2e.ts:15`).
2. Load the live URL in a browser at 375×812 and play at least one round with
   `scripts/bots.ts` against the live deployment.
3. Confirm the error paths on the live URL specifically: 404 for an unknown
   table, 400 for an over-long rename and for malformed JSON, 405 for a wrong
   method, and that bare `/api` reaches the Worker rather than the asset binding.

**Note.** This writes real rows into the live D1 database. That is acceptable
and expected for a demo; say so rather than trying to clean up.

**Acceptance criteria.** 25/25 harness checks against the live URL, with the
output shown. A screenshot of the live page on a phone viewport. An explicit
list of anything that behaved differently than it did locally — particularly
timing, WebSocket hibernation, or alarm behaviour, which are the things local
`wrangler dev` simulates least faithfully.

---

## R5 — Redeploy and prove persistence

**Why.** A deploy proves packaging. This proves the D1 rows and Durable Object
state actually survive a new version, which is the claim worth making.

**Do.**

1. From R4, note a specific finished `gameId` visible in `/api/history` and its
   `tables` row.
2. Redeploy with the same command. Confirm the output reports the account as
   **`(reused)`** and bindings as **`(inherited)`** — a newly created account
   means the cache was lost and the R3 claim URL is now worthless.
3. Re-query `/api/history` for that same `gameId` and confirm the row and its
   per-player rows are unchanged.
4. Start a fresh game, leave it mid-round, redeploy again, reconnect, and
   confirm the Durable Object still holds the live game (correct round, phase,
   lives, and cup holder).

**Watch the persisted state shape.** `07fb73e` added `eliminationIndex` to
`MiaState.players`, and there is no state versioning or migration anywhere. This
step is the one that actually exercises a redeploy across a shape change, so if
a future task changes the shape again, a game started before the redeploy and
finished after it is the case to check — including the places it writes.

**Acceptance criteria.** Explicit before/after evidence for both D1 and the
Durable Object — the actual values compared, not a claim that they matched. The
`(reused)`/`(inherited)` lines quoted from the deploy output.

---

## R6 — Config hygiene and the hand-over report

**Do.**

1. Re-read `wrangler.jsonc` and strip any `database_id` or other
   account-specific ID that auto-provisioning wrote back. The committed config
   must still deploy cleanly into a *fresh* account.
2. Audit for leaks: `git ls-files` must contain nothing under `.cfstate/`, and
   `git log -p` must not contain a claim URL, token, or account ID.
3. Final `progress.md` update.
4. Write the hand-over report per the "Handing over" section above.

**Acceptance criteria.** The report contains: the live URL; the claim URL framed
as a bearer credential with its deadline in absolute UTC; the consequence of not
claiming (account and all resources deleted); and an honest, specific account of
what was verified and what was not. No secrets in tracked files or in git
history.

---

## Deferred — deliberately not in scope

State these as known and intentional rather than fixing them mid-task:

- `toSummary`'s `hostName` is hardcoded to `"someone"`
  (`src/worker/db.ts:144`). The client never renders it, so it is a dead field,
  not a visible bug. Populating it needs a join against `players`.
- The 60-second turn timer never fires during normal harness play. Its
  behaviour is covered deterministically by `test/room.test.ts` with a fast
  clock, not end to end.
- The double-Mia penalty is *reported* by the harness rather than asserted,
  because whether it occurs is luck. It is pinned deterministically in
  `test/mia.test.ts`.
- No rate limiting, abuse protection, or table capacity enforcement beyond
  `MAX_PLAYERS`. This is a low-stakes demo, per the original requirements.

## Review protocol

For each task, the review will check:

1. **The claim matches the evidence.** Commands shown were actually run, and
   their real output supports the conclusion drawn.
2. **Nothing sensitive leaked** into tracked files or git history.
3. **The suite still passes** — 45+ tests and both typechecks — and the e2e
   harness still reaches 25/25.
4. **Scope held.** Defects found in passing were either fixed with a
   regression test or explicitly recorded, not silently absorbed or silently
   ignored.
5. **`progress.md` reflects reality**, including anything left undone.

---

# Code review findings — additional tasks

A read-through of `src/`, `client/` and the tests at commit `fc507d3`. Nothing
below is fixed; each item is a task. File:line references are to that commit.

Severity is about user impact, not effort. **B2–B5 should be done before R3
(deploy)** — B2 corrupts the only data the product persists, and B5 produces
dead tables on the shared link that is the whole point of the demo. B1 is done.
The rest can follow the R-series.

**Checked and found clean**, for the record: every user-controlled string
reaching the DOM goes through `escapeHtml` (no XSS found); cookie signing,
constant-time verification, and the `Secure`/`HttpOnly`/`SameSite` attributes
are sound; `crypto.getRandomValues`/`randomUUID` are used throughout with no
`Math.random()` in security or game paths; no secrets are in tracked files or
git history; the D1 result write is a single atomic `batch`.

---

## B1 — Abandoned tables enter a permanent alarm loop — **DONE** (`ea28513`)

`maybeReapEmptyRoom` was unreachable for any table that had ever had a player,
and the fallthrough rescheduled an already-past `emptySince + TTL`, refiring
forever and deleting nothing.

Fixed by reaping before the phase dispatch, routing every `setAlarm` through
`clampAlarmTime` so no target is ever in the past, persisting `emptySince` so
the TTL survives hibernation, and deleting the alarm along with the storage.

**Reviewed and approved.** Verified independently: 47 tests pass, both
typechecks clean, and the new test genuinely fails when both reap paths are
removed. No live game can be reaped — `hasPendingWork` is true for every
in-play phase.

Review notes, carried forward rather than lost:

- The two reap paths (the `alarm()` early check and the `ensureAlarm`
  no-sockets branch) are **individually redundant** — removing either one alone
  leaves every test passing. The outcome is pinned; neither mechanism is.
- The `return` → `break` in `autoPlay` fixed a second, undocumented bug: the old
  early return skipped `ensureAlarm` when auto-play reached a **reveal**, and
  since `commit` never arms alarms, such a table stalled in `revealing`. The
  regression test it deserves is in **B11**.
- The residual 1 Hz alarm loop is **B11**; the untested pre-game reap path is
  folded into **B5**.

---

## B2 — Finishing places from seat order — **DONE** (`07fb73e`)

Places came from the player's index in the roster, so a winner in a middle seat
recorded the others as 2, 3 and 5 — a skipped place, in an arbitrary order.

Fixed by recording a 1-based `eliminationIndex` on each player in
`resolveEliminations` and deriving places from a new pure `finalStandings(state)`
— winner first, then everyone else in reverse elimination order. `writeResults`
maps it straight onto the `game_players` rows.

**Reviewed and approved.** Verified independently: 50 tests pass, both
typechecks clean, e2e 25/25, and the workers test genuinely fails when the
seat-index formula is restored. Places written by a live run read back dense
(1, 2, 3). The simultaneous-elimination tie rule is documented in the code and
tested, and is unreachable in normal play — one doubt can only cost one player
lives.

Review note, carried forward: `eliminationIndex` is the **first change to the
persisted `MiaState` shape**, and there is no state versioning. See the
follow-ups in **B10** and the caution added to **R5**.

---

## B3 — A failed result write is lost — **DONE** (`eb8d1db`)

`writeResults` swallowed a D1 failure behind a comment claiming the next load
would retry; nothing did. The fix also caught a second, sharper bug the task had
missed: the constructor *inferred* `resultsWritten` from `state.gameOver`, so a
reload after a failed write marked the result written and dropped it for good.

Fixed by persisting a `resultsWritten` marker written only once D1 has the rows,
retrying on the alarm with a 1s→5min capped backoff, giving a pending result
precedence over both the phase dispatch and the reaper, arming an immediate
alarm on load, and making `syncTableRow("finished")` rethrow so a failed lobby
update keeps the retry alive.

**Reviewed and approved.** Verified independently: 54 tests pass, both
typechecks clean, e2e 25/25. Three mutations each break exactly one test —
restoring `resultsWritten = gameOver !== null`, removing the reaper guard, and
removing the retry arming. Unlike B1, the mechanisms are pinned individually,
and the reap test invokes `maybeReapEmptyRoom` directly rather than relying on
an outer path. The `state.abort()` eviction test is the right way to prove the
load-time retry.

Review notes, carried forward:

- **A permanently failing D1 now makes every finished table immortal.** The
  pending-result check is the first thing `ensureAlarm` does, so the room is
  never reaped and retries every 5 minutes forever — in tension with B1, whose
  point was that abandoned rooms must stop billing. The author called this out
  as a deliberate trade-off (the result is the only copy of the game). Bounding
  it is **B11**.
- **Idempotency is asserted but never exercised.** See **B10**.

---

## B4 — The turn countdown is frozen — **DONE** (`c0f396b`)

`secondsLeft` measured the drift and consumed it in the same expression, so
`deadline - (Date.now() - (Date.now() - serverTime))` collapsed to
`deadline - serverTime` — constant for the life of a snapshot.

Fixed with a pure `TurnClock` (`src/shared/clock.ts`) whose `sync()` is the only
place the drift is measured, once per snapshot, and whose `secondsLeft()`
evaluates against a live `Date.now()` on every call. The old helper in
`client/src/net.ts` is gone.

**Reviewed and approved.** Verified independently: 58 tests pass, both
typechecks and `vite build` clean, e2e 25/25. Reproducing the original
arithmetic faithfully (storing `serverTime` and re-deriving the drift per call)
breaks three of the four new tests, reporting exactly the constant 60 the author
described. The author correctly noted that e2e is protocol-level and cannot
exercise a client-only fix — it is a non-regression check only.

Review note, carried forward to **R1**: fixing this **activated a once-per-second
full-page re-render**. `table.ts:371` re-renders whenever the integer changes,
which previously meant roughly once per snapshot, because the value never moved.
It now means every second of every turn, and `render()` replaces the whole page
with `app.innerHTML`. There are no inner scroll containers to reset, so this is
a "confirm it feels right" item rather than a known breakage — but text
selection, CSS transitions and in-flight taps are all discarded each second, on
a phone. The targeted fix is to update the countdown's own text node in the
interval and reserve `render()` for real state changes.

---

## B5 — A host who closes their tab leaves the table permanently unstartable

**Severity: high.** Produces dead tables that the lobby keeps advertising.

Two defects compound:

1. `afterDisconnect` (`table-room.ts:203`) never removes the player from the
   roster. `handleLeave` does (`table-room.ts:394`), but only on an explicit
   `leave` message — closing a tab or losing signal sends none. Pre-game tables
   therefore accumulate ghost seats.
2. `handleStart` requires the caller to be `state.players[0]`
   (`table-room.ts:376`). If that seat is a ghost, **nobody can start the game**,
   and the table sits in the lobby forever showing phantom players.

`afterDisconnect` also never calls `syncTableRow`, so the D1 `player_count` the
lobby renders is stale after any disconnect.

**Do.** On disconnect from a table that has not started (`round === 0`), drop
the seat and `syncTableRow`. Mid-game, keep the seat — auto-play already covers
it, and that is the intended behaviour. Reassign host to the first *connected*
seat, or let any connected player start once the original host is gone.

**Also cover the untested reap path here**, since it is the same code. B1's test
reaps a *finished* game. The commonest real case is an abandoned **pre-game**
table — somebody creates one, nobody joins, they close the tab. That path works
by inspection (`newLobbyState` leaves `roundEndsAt` null, so `needsImmediateWake`
is false and the room is collectable) but nothing exercises it.

**Acceptance.** A workers test: two players join, the host's socket closes, the
remaining player can start; the D1 `player_count` matches the live roster after
a disconnect; and an abandoned pre-game table with no sockets is reaped past a
shortened TTL.

---

## B6 — Two divergent implementations of the dice-secrecy boundary

**Severity: medium.** This duplication is exactly how the leak fixed in
`1a9bb09` happened.

`redactFor` (`table-room.ts:630`) and `buildView`/`redactState`
(`src/shared/mia.ts:784`) both implement redaction, differently. The shared one
is now per-player and correct; the DO's is phase-based and, once
`publicDice` is true, returns **every** player's dice rather than only the
doubted player's. It is currently harmless because `takeCup` keeps just one pair
of dice in the state — that is one accident away from leaking again.

**Do.** Delete `redactFor` and have the DO call the shared `buildView`. One
implementation, one test suite.

**Acceptance.** `redactFor` is gone; the existing workers redaction test still
passes; a test asserts that a planted stray pair of dice is not revealed to
anyone at reveal time.

---

## B7 — Concurrent first requests can mint competing session keys

**Severity: medium-low.** Rare, but silently and permanently logs people out.

`loadSigningKey` (`src/worker/session.ts:46`) reads `app_config`, and on a miss
generates a key and writes it with `setConfig`, which upserts
(`db.ts:81`: `ON CONFLICT ... DO UPDATE SET value = excluded.value`). Two
isolates racing on a cold database both see the miss, both generate, and the
second overwrites the first. Every cookie already signed with the losing key
fails verification forever — those players lose their identity and their name
with no way back.

**Do.** Make key creation write-once: `ON CONFLICT (key) DO NOTHING`, then
re-`SELECT` and use whichever value actually landed.

**Acceptance.** A test that two concurrent `getSigningKey` calls against a cold
database converge on the same key.

---

## B8 — Queued client actions are replayed after a reconnect

**Severity: medium.**

`TableSocket.send` (`client/src/net.ts:113`) queues up to 8 messages while
offline and replays them on reconnect. If the socket dropped *after* the server
applied the action but before the broadcast arrived, the replay is a second,
stale action. Most are caught by the phase guards, but the intent is stale by
construction: by reconnect time the game may be several turns on.

**Do.** Either drop the queue on reconnect (the client re-derives from the
snapshot anyway), or stamp each action with the `logSeq`/round it was decided
against and have the server reject stale ones.

**Acceptance.** A test that a replayed action from a previous round is rejected
rather than applied.

---

## B9 — Test seams are public RPC methods on the production Durable Object

**Severity: low-medium.**

`__setDiceForTest`, `__stateForTest` and `__setTimingsForTest`
(`table-room.ts:575`–`599`) can force dice into a live game and read the
unredacted state. Only the Worker holds the binding and it never exposes them,
so this is not currently reachable — but a single future route that forwards a
method name turns it into a cheat and a dice oracle.

**Do.** Move them behind a build-time flag, or put them on a test-only subclass
that the production entrypoint does not export.

**Acceptance.** The production bundle contains no `__*ForTest` methods; the
workers tests still pass.

---

## B10 — Minor gaps, worth one cleanup pass

- **The partial-failure retry path is untested.** `writeResults` claims a retry
  after a partial failure is safe because `recordGame` is idempotent
  (`ON CONFLICT DO NOTHING`), but the test fault injection throws *before*
  `recordGame`, so every covered failure is a total one. The case that actually
  exercises idempotency — the `game_players` rows land and then
  `syncTableRow("finished")` throws — is never driven. Inject a failure between
  the two and assert the retry produces no duplicate rows.
- **Fault injection lives in the production write path.** `resultWriteFailures`
  and `resultWriteAttempts` (`src/worker/table-room.ts`) are test-only state,
  and `writeResults` checks the failure counter on every real write. They are
  private with no RPC surface — much better than the `__*ForTest` methods in
  **B9** — but fold them into whatever that task does about test seams.
- **`eliminationIndex` counter miscounts old-shaped records.**
  `resolveEliminations` (`src/shared/mia.ts`) computes the next index with
  `filter((p) => p.eliminationIndex !== null)`, and `undefined !== null` is
  true — so a player record persisted before `07fb73e` counts as already
  indexed and inflates the counter. Verified harmless in practice: standings
  stay dense and the winner is right, because `finalStandings` sorts on
  `?? 0`; only the relative order of players eliminated *before* the upgrade
  degrades to seat order. Use `!= null`, or normalise the field when loading
  state.
- **The e2e harness does not assert places.** `scripts/e2e.ts` only checks the
  per-player row *count*. It finishes a real game every run, so asserting that
  places are dense, start at 1, and put the winner first is nearly free.
- **Unbounded scan per new player.** `listPlayerNames` (`db.ts:118`) does
  `SELECT name FROM players` with no limit, on every first visit, only to avoid
  a duplicate ship name. Bound it — sample recent names, or retry on a unique
  constraint.
- **No rate limiting anywhere.** In particular `ping` (`table-room.ts:330`)
  triggers a full redacted broadcast to every socket, so one client can amplify
  traffic to the whole table at will.
- **Mutation before persistence.** `handleConnect` (`table-room.ts:89`) mutates
  `this.state` in place and then calls `persistAndBroadcast`, against the
  persist-first rule the rest of the file follows.
- **Host identity disagrees between layers.** D1 stores `host_id` at creation
  (`db.ts:184`); the DO treats `players[0]` as host. A host who never connects
  makes the error message at `table-room.ts:377` false.
- **No rematch.** `handleStart` refuses once `round > 0`, so a table is
  single-use. Reasonable, but the UI never says so — players at a finished table
  have no path forward except returning to the lobby.
- **Spectators are silently permitted.** A player joining a started game is sent
  an error but stays connected and keeps receiving broadcasts
  (`table-room.ts:105`). Fine if intended — decide, then say so.
- **`tableId()` falls back to `"unknown"`** (`table-room.ts:434`), which would
  write result rows against a bogus table id rather than failing loudly.
- **Full `innerHTML` re-render** on every snapshot (`table.ts:291`,
  `lobby.ts:129`) resets scroll position mid-game. The lobby already guards the
  rename field via `editingName`; the table page has no such guard. R1 should
  confirm how this feels on a phone.
- **Set-Cookie on a 101 response.** The WebSocket upgrade goes through
  `decorate`/`attachSession` (`src/worker/index.ts:183`), which rebuilds the
  response. It works today — the harness connects fine — but a new player whose
  very first request is the WebSocket may not get their cookie stored.

---

## B11 — Residual alarm-scheduling gaps left by the B1 fix

**Severity: low-medium.** Raised by the review of `ea28513`. Neither item is a
regression — both predate that commit — but they are the same class of failure
it set out to eliminate, so they belong with it.

**1. A 1 Hz alarm loop can still run forever with nobody connected.**
`ensureAlarm` (`src/worker/table-room.ts`) checks `needsImmediateWake` *before*
the no-sockets branch, so a table whose beat is perpetually due never reaches
the reaper. The reachable path: `autoPlay` rejects its own move
(`applyAction` fails → `console.error` → `break`), leaving the phase unchanged
with an expired deadline; `ensureAlarm` then schedules `now + 1s`; the alarm
fires, dispatches to `autoPlay`, and fails again. It needs a logic
inconsistency to start, but once started it never stops and is never reaped.

**Do.** Cap it: count consecutive wakes that produce no state change and, past
a small bound, stop re-arming — and let the no-sockets reap take precedence
over `needsImmediateWake` when no progress is being made. A table nobody is
connected to should never be able to spin indefinitely.

**2. The reveal-stall fix has no test.** The `return` → `break` in `autoPlay`
in `ea28513` fixed a real bug that the commit message describes only as "gets
its reap alarm": the old early return skipped `ensureAlarm` when auto-play
reached a **reveal**, and because `commit` never arms an alarm, such a table
stalled in `revealing` with no clock to resolve it. Nothing pins this.

**Do.** A workers test driving a table to a reveal **via auto-play** (not via a
player's `doubt`) that asserts an alarm is armed and the reveal resolves into
the next round.

**3. An unwritable result keeps a room alive forever.** `eb8d1db` gave a pending
result precedence over the reaper — correctly, since it is the only copy of the
game — but with no upper bound. If D1 is durably broken, every finished table
retries every 5 minutes indefinitely and is never collected, which is the B1
billing problem at a slower rate. The author flagged the trade-off deliberately;
this is the follow-up.

**Do.** Bound the total retry window (hours, not forever). On expiry, log the
full result payload loudly enough to be recoverable from logs, then let the
reaper take the room.

**Acceptance.** A test for each: one asserting a stuck auto-play stops re-arming
and the room is eventually reaped, one asserting an auto-played reveal resolves,
one asserting a room whose result never lands is eventually given up on and
collected.
