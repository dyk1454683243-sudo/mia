# Mia — implementation progress

Status snapshot written mid-implementation so the work can be resumed cold.
`PLAN.md` is the spec; this file is where the build actually got to.

## Done and verified

Everything below is written and passing.

- **Config**: `package.json`, `tsconfig.json` + `tsconfig.worker.json` +
  `tsconfig.client.json`, `vite.config.ts`, `vitest.config.ts`, `wrangler.jsonc`,
  `.gitignore`.
- **Pure rules engine** `src/shared/mia.ts` (786 lines): ranking, legal moves,
  full state machine, redaction, auto-play. No Cloudflare imports.
- **Shared contract** `src/shared/protocol.ts`, `src/shared/ships.ts`.
- **Worker** `src/worker/index.ts` (routes, `/t/:id`, API, WS upgrade proxy),
  `src/worker/session.ts` (HMAC cookie in D1, constant-time verify),
  `src/worker/db.ts` (lazy `ensureSchema`, lobby queries, result writes).
- **Durable Object** `src/worker/table-room.ts` (648 lines): hibernation
  WebSockets, one alarm for turn clock + reveal beat, per-socket redaction,
  D1 result write on game over.
- **Client**: `client/index.html`, `client/table.html`, `client/src/lobby.ts`,
  `client/src/table.ts`, `client/src/net.ts`, `client/src/styles.css`.
- **Tests**: `test/mia.test.ts` 36 passing, `test/room.test.ts` 6 passing (42 total).
- `npx tsc --noEmit -p tsconfig.worker.json` and `-p tsconfig.client.json`: clean.
- `vite build`: clean, both pages emitted to `dist/client`.

Verified by the suite: full ranking order, strictly-higher announcements, all
three doubt outcomes including the double-Mia penalty, next-round starter,
elimination, win detection, auto-play, per-socket dice redaction, D1 result rows
after a finished game, and a real WebSocket game driven end to end.

## Bugs found and fixed along the way

1. **Doubt resolution compared dice arithmetically.** `actual < announced` is
   wrong: the ranking is a table, and doubles outrank higher face values. Fixed
   to rank comparison (`!outranks(actual, announced) && actual !== announced`).
   Equality is an honest announcement.
2. **A player holding the cup could doubt.** Core rules say you must announce
   after rolling; doubting is the *next* player's choice, made instead of
   picking up the cup. Removed `canDoubt` from the `announcing` phase.
3. **`ctx.id.name` is empty for DOs created with `getByName`.** The Worker now
   passes `X-Mia-Table-Id` with the upgrade.
4. **Redaction keyed off phase instead of state.** Mid-round the cup holder must
   keep seeing their dice; keyed off `diceOwnerId` now.
5. **Static asset handling broke `/t/:id`.** With default `html_handling`,
   fetching `/table.html` internally produced a `307 -> /table`, so the join
   link redirected and lost the table id. Fixed with
   `"html_handling": "none"` and `"not_found_handling": "none"` in `wrangler.jsonc`.
   Confirmed: `/` 200, `/table.html` 200, `/t/:id` 200, `/table` 404,
   `/nonexistent` 404, `/api/me` 200.

## Current blocker

`scripts/e2e.ts` — the local end-to-end harness — stalls. It gets through
identity, lobby, table creation, and the start of a game, then wedges in a loop:

```
step 25..375: round 1 phase announcing turn 5edc standing 31 lives 6/6/6
```

The harness plays each player with the server's own `autoPlaySequence`, and it
appears to keep re-sending an action the server rejects (its errors are not
surfaced, which is itself a harness bug). Likely causes to check first:

- The per-action wait predicate in `playGame` can be satisfied by the *previous*
  snapshot, so the harness advances on stale state and re-sends the same action.
- Action errors are collected in `Client.errors` but never asserted, so a
  rejected action loops instead of failing loudly.

Fix the harness to (a) record a state sequence number and wait for a *newer*
snapshot, and (b) fail immediately on a server `error` message. The server side
is already covered by `test/room.test.ts`, which drives a full game to a win and
asserts the D1 rows, so this is very likely harness-only.

## Not started

- Local e2e must pass (blocker above).
- Turn-timer expiry and mid-game reconnect checks in the harness (the timer is
  already covered by `test/room.test.ts` with a fast clock).
- `npx wrangler deploy --temporary` and live-URL verification.
- One redeploy into the same cached temporary account; confirm D1 + DO survive.
- Strip any provisioned resource IDs written back into `wrangler.jsonc`.
- `README.md` and the hand-over report (live URL, claim URL with absolute UTC
  deadline, what was and was not verified).

## Environment notes (this sandbox)

- `~/.npm` is not writable: use
  `npm_config_cache=$PWD/.npm-cache npm ...` (`.npm-cache/` is gitignored).
- Wrangler's default config dir is not writable: prefix wrangler commands with
  `XDG_CONFIG_HOME=$PWD/.cfstate XDG_CACHE_HOME=$PWD/.cfstate/cache`
  (`.cfstate/` is gitignored and holds the temporary account credentials).
- Wrangler is logged out, which is what `--temporary` requires.
- Node v26.8.2 runs `.ts` files directly, and its global `WebSocket` accepts
  custom headers, so the e2e harness can send the session cookie.
