# Mia — implementation progress

Status snapshot, written after pausing work at the user's request.
`PLAN.md` is the spec; this file is where the build actually got to.

## Done and verified

- **Config**: `package.json`, `tsconfig.json` + `tsconfig.worker.json` +
  `tsconfig.client.json`, `vite.config.ts`, `vitest.config.ts`, `wrangler.jsonc`,
  `.gitignore`.
- **Pure rules engine** `src/shared/mia.ts`: ranking, legal moves, full state
  machine, auto-play, per-viewer redaction. No Cloudflare imports.
- **Shared contract** `src/shared/protocol.ts`, `src/shared/ships.ts`.
- **Worker** `src/worker/index.ts` (routing, `/t/:id`, JSON API, WS upgrade
  proxy), `src/worker/session.ts` (HMAC cookie signed with a D1-stored key,
  verified in constant time), `src/worker/db.ts` (lazy `ensureSchema`, lobby
  queries, result writes).
- **Durable Object** `src/worker/table-room.ts`: hibernating WebSockets, one
  alarm driving both the 60-second turn clock and the reveal/round beats,
  per-socket redaction, D1 result write on game over.
- **Client**: `client/index.html`, `client/table.html`, `client/src/lobby.ts`,
  `client/src/table.ts`, `client/src/net.ts`, `client/src/styles.css`.
- **Tests**: `test/mia.test.ts` 36 passing, `test/room.test.ts` 6 passing
  (42 total), covering the ranking order, strictly-higher announcements, all
  three doubt outcomes including the double-Mia penalty, next-round starter,
  elimination, win detection, auto-play, per-socket dice redaction, a full
  WebSocket game, the D1 result rows, and the timer.
- `npx tsc --noEmit -p tsconfig.worker.json` and `-p tsconfig.client.json`: clean.
- `vite build`: clean; both pages emitted to `dist/client`.
- Local dev server confirmed by hand: `/` 200, `/table.html` 200, `/t/:id` 200,
  `/table` 404, `/nonexistent` 404, `/api/me` 200 with a correct `HttpOnly;
  SameSite=Lax; Path=/` session cookie, `PATCH /api/me` trims and validates.

## Bugs found and fixed

1. **Doubt resolution compared dice arithmetically.** `actual < announced` is
   wrong: the ranking is a table and doubles outrank higher face values. Now a
   rank comparison, with equality counting as an honest announcement.
2. **A player holding the cup could doubt.** Core rules say you must announce
   after rolling; doubting is the next player's choice, made instead of picking
   up the cup. `canDoubt` removed from the `announcing` phase.
3. **`ctx.id.name` is empty for DOs reached via `getByName`.** The Worker now
   forwards `X-Mia-Table-Id` with the upgrade.
4. **Redaction keyed off phase instead of state.** Mid-round the cup holder must
   keep seeing their own dice. Now keyed off `diceOwnerId`.
5. **Static asset handling broke `/t/:id`.** With the default `html_handling`,
   the Worker's internal fetch of `/table.html` produced `307 -> /table`, so the
   shareable join link redirected and lost the table id. Fixed with
   `"html_handling": "none"` and `"not_found_handling": "none"`.

## Current blocker

`scripts/e2e.ts` (the local end-to-end harness) still cannot finish a game. It
gets through identity, lobby, table creation, the WebSocket upgrade, and the
first two turns, then wedges.

Latest trace (`MIA_TRACE=1 MIA_STEP_LIMIT=60 node scripts/e2e.ts`):

```
step 0: round 1 phase deciding turn 1f8a standing - lives 6/6/6
  [trace] actor=p1 phase=deciding turn=1f8a cup=none standing=- seq=5
          queue=[roll, announce 31]
  [trace] actor=p3 phase=deciding turn=16be cup=1f8a standing=31 seq=6
          queue=[believe, announce 32]
stuck at round 1 phase announcing lives 6/6/6
```

So p3 chose `believe` then `announce 32`, sent both, and the table stayed in
`announcing` with p1's 31 still standing. The next loop iteration reads p1's
snapshot, whose turn is no longer current, breaks out of the retry loop without
acting, and spins. The evidence points at the **harness**, not the server:

- `test/room.test.ts` drives the same sequence (`roll`, `announce`, `believe`,
  `announce`, `doubt`) over real WebSockets in workerd and passes, including two
  chained announcements and the D1 write on game over.
- The harness sends `believe` and its queued `announce` back to back, waiting on
  a fresh snapshot after each. The `believe` wait predicate is
  `state.phase === "announcing"`, which is also true of the state that existed
  *before* the believe, and the `announce` wait is for
  `lastAnnouncement?.value === value` where `value` was computed from the
  pre-believe snapshot.

Prime suspects, in order:

1. The `waitNext` predicate for `believe`/`roll` (`phase === "announcing"`)
   cannot distinguish the pre-action state from the post-action state, so a
   queued action can be released against the wrong snapshot.
2. `autoPlaySequence` is computed once from a snapshot, then its actions are
   played one at a time; if a snapshot arrives between them the second action is
   stale by construction. Recomputing the queue from the actor's own lookahead
   state between actions is the likely correct shape.
3. `attempt < 2` retry budget in the driver may be too small once a stale
   snapshot is involved.

Diagnostics added and still in place: `MIA_TRACE=1` prints each decision
(actor, phase, turn, cup, standing, sequence, chosen queue) and each retry;
`MIA_STEP_LIMIT` caps the loop so a wedged run exits quickly. `Client` now
rejects pending waiters on a server `error` message, so rejections surface
instead of silently looping.

## Not started

- Local e2e passing (blocker above). The timer-expiry and reconnect checks in
  the harness are written but have never run to completion; the timer itself is
  covered by `test/room.test.ts` with a fast clock.
- `npx wrangler deploy --temporary` and live-URL verification.
- One redeploy into the same cached temporary account; confirm D1 and DO state
  survive.
- Strip any provisioned resource IDs written back into `wrangler.jsonc`.
- `README.md`, and the hand-over report (live URL, claim URL with an absolute
  UTC deadline, and an honest account of what was and was not verified).

## Environment notes (this sandbox)

- `~/.npm` is not writable: use `npm_config_cache=$PWD/.npm-cache npm ...`
  (`.npm-cache/` is gitignored).
- Wrangler's default config dir is not writable: prefix wrangler commands with
  `XDG_CONFIG_HOME=$PWD/.cfstate XDG_CACHE_HOME=$PWD/.cfstate/cache`
  (`.cfstate/` is gitignored and will hold the temporary account credentials —
  never commit, log, or display them).
- Wrangler 4.131.1 is installed and logged out, which is what `--temporary`
  requires.
- Node v26.8.2 runs `.ts` files directly, and its global `WebSocket` accepts
  custom headers, which is how the harness sends the session cookie.
