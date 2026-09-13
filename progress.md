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

## Fixed: the e2e harness stall

`scripts/e2e.ts` wedged on turn two. The server was never at fault — the bug
was in the harness's decision loop, and there were two of them.

**1. Cross-client staleness with no wait.** The loop read `turnPlayerId` from
player one's snapshot, looked up that player's client, and then checked whether
*that* client's own snapshot agreed. Clients receive the same broadcast
microseconds apart, so the actor was routinely still a beat behind. When the two
views disagreed the loop `break`ed out of the retry without awaiting anything —
so it burned the entire step budget in microseconds and reported a stall. Two
runs wedged at different phases for exactly this reason.

Fixed by inverting the selection: the actor is now chosen as *the client whose
own view says it is its own turn*, so a stale snapshot simply means no actor is
found yet. Every path that cannot act now awaits the next broadcast
(`nextSnapshot`) instead of spinning.

**2. Stale precomputed action queues.** `autoPlaySequence` returns pairs such as
`[believe, announce 32]`, where the announcement is derived from the pre-believe
state. The driver sent both back to back, so the second action was stale by
construction. The loop now takes **one** action per iteration and recomputes it
from the actor's current view.

Supporting fixes: a server refusal is now always recorded *and* rejects pending
waiters (it could previously be swallowed, so a refusal looked like a timeout);
waiters clear their timers on settle; and a `logSeq`-based stall detector fails
the run with real diagnostics after 30s of no progress instead of silently
exhausting the step budget.

**3. The harness needed a real strategy.** It had been reusing the server's idle
fallback, which always announces the minimum legal value. That climbs the whole
21-value ladder every round (~40 turns) and leaves the standing announcement a
bluff virtually every time, so the "a failed doubt cost the doubter a life"
check could never have passed. `chooseAction` now announces the truth whenever
the truth is legal and doubts opportunistically, off a seeded PRNG
(`MIA_SEED`) so a failing run replays exactly.

## Bugs found and fixed (continued)

6. **The shared redaction helper leaked every player's dice to the cup holder.**
   `redactState` asked only *whether* the viewer could see dice, not *whose*, so
   a viewer holding the cup received every other player's dice too — the entire
   bluff, exposed. The Durable Object has its own correct `redactFor`, so
   nothing leaked over the wire, but the shared module used by the tests and the
   client was a divergent, weaker second implementation of the security
   boundary. `redactState` now filters per player: your own dice while you hold
   the cup, or the doubted player's once they are face up, and nothing else.
7. **Player names were never percent-decoded.** The Worker forwards the name to
   the Durable Object as `X-Mia-Name`, percent-encoded because headers are
   latin-1 and Culture ship names are full of spaces. The DO decoded
   `X-Mia-Table-Name` but not `X-Mia-Name`, so the first green run announced its
   winner as `Unacceptable%20Behaviour` — mangled in the roster, the event log
   and the D1 result rows alike. Both headers now go through one tolerant
   `decodeHeader`.
8. **Dice were left behind on every previous cup holder.** `believe` set the new
   holder's dice without clearing the old holder's, so mid-round several players
   carried live dice in the state and a reveal turned all of them face up. There
   is one cup: `takeCup` now clears the others.

## Verified end to end

`node scripts/e2e.ts` against `wrangler dev`: **25/25 checks pass**, twice, with
a different game each run. A representative run: 17 rounds, 16 reveals, 6 caught
bluffs costing the announcer, 10 failed doubts costing the doubter, one
double-Mia penalty in the earlier run, a single winner, the `tables` row flipped
to `finished`, the game and its three per-player rows in D1 via `/api/history`,
every error path (404/400/405, bare `/api`), and a mid-game reconnect that
restores the roster and leaves the cup where it was.

`npx vitest run`: 45 passing (39 unit + 6 workers). Both typechecks clean.

## Not started
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
