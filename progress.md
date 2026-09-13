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

## Fixed: B1 — abandoned tables entered a permanent alarm loop

`maybeReapEmptyRoom` was only reachable from `alarm()` when
`this.state === null`, so a table that had ever had a player was never reaped:
`EMPTY_TABLE_TTL_MS` was dead code. A finished table whose sockets had all gone
then matched no phase branch and fell through to `ensureAlarm`, which
rescheduled the same unchanged `emptySince + TTL` — a timestamp already in the
past — so the alarm refired immediately, forever, deleting nothing.

- `alarm()` now checks "no sockets and nothing left to play" **before** the
  phase dispatch, independent of whether state exists, and runs the reaper. A
  game still mid-turn with nobody connected is not dropped mid-game: a due
  turn, reveal or round-start counts as pending work, so it auto-plays to its
  end as before and is reaped afterwards.
- Every alarm this class arms goes through `scheduleAlarm`/`clampAlarmTime`,
  which nudges an already-past target to `now + 1s` instead of handing it to
  `setAlarm`. A genuine future deadline is passed through untouched.
- The empty timestamp is now **persisted** (`emptySince` key) as well as
  cached. Without that, the object hibernating between the disconnect and the
  reap alarm would cold-start with a null timestamp, roll the TTL forward and
  never free the storage — the leak would survive the fix.
- Reaping deletes the alarm as well as all storage, so the object goes dormant.
- `autoPlay` now always ends in `ensureAlarm` (it used to return early on game
  over), so a game that finishes by server auto-play still schedules its own
  reap.

Verified: `npx vitest run` **47 passing (39 unit + 8 workers)**; both
typechecks clean. Two new workers tests: `clampAlarmTime` never returns a
target at or before now, and a two-player game driven to game over with both
sockets closed is reaped past a shortened TTL, asserting the `room` key is
gone and `getAlarm()` is null. Note the test shortens the TTL through a private
field; it does not exercise a real 60-minute wait, and it does not exercise an
actual hibernation between the disconnect and the reap.

Not verified: any of this against a live deployment (nothing is deployed yet),
and the reap path has not been observed end to end through `wrangler dev` —
only in the workers pool.

**Reviewed and approved.** Independently confirmed: 47 tests pass, both
typechecks clean, and the new test genuinely fails when both reap paths are
removed. Three things the review surfaced, all recorded as tasks rather than
fixed in place:

- The two reap paths are individually redundant — removing either one alone
  leaves every test green. The outcome is pinned; neither mechanism is.
- The `return` → `break` in `autoPlay` fixed a second, undocumented bug (a table
  could stall in `revealing` when auto-play reached the reveal). It has no test:
  **B11**.
- The reaper can now delete a finished game whose D1 result write failed, which
  caps the recovery window B3 was going to rely on: folded into **B3**.
- B1's test reaps a *finished* table; the commoner abandoned **pre-game** table
  is untested: folded into **B5**.

## Fixed: B2 — finishing places came from seat order

`writeResults` computed `place: winner ? 1 : index + 2` from the player's index
in the roster, which has nothing to do with who survived longest. A winner in a
middle seat therefore wrote places with a gap: won from seat 2 of 4, the others
were recorded as 2, 3 and 5.

- `MiaPlayer` carries `eliminationIndex: number | null`, assigned once in
  `resolveEliminations`; the winner stays null.
- New pure `finalStandings(state)` (`src/shared/mia.ts`) returns every player
  with a place — winner 1st, then the eliminated in reverse elimination order,
  so the last player out finishes highest.
- `writeResults` maps `finalStandings` straight onto the `game_players` rows;
  the seat-index formula is gone.
- **Tie rule, stated:** a single life-loss event can only knock out one player,
  so simultaneous elimination cannot happen in normal play. If a resolution
  ever finds two players at zero lives at once, roster order decides — the
  earlier seat is recorded as eliminated first and therefore finishes lower.

Verified: `npx vitest run` **50 passing (41 unit + 9 workers)**; both
typechecks clean. New tests:

- unit — a 4-player game where Anna and Bo are caught bluffing and Dan's doubt
  of Cara's honest 66 costs Dan his life: Cara wins from seat 2 and the
  standings are Cara 1, Dan 2, Bo 3, Anna 4.
- unit — two players brought to zero lives in the same resolution get
  `eliminationIndex` 1 and 2 in roster order (the tie rule).
- workers — the same 4-player shape driven over real WebSockets, asserting the
  live `eliminationIndex` values and the `game_players` places 1–4 with no gap.

The workers test was run against the old formula and does fail it, reproducing
the seat-index output including the skipped place 5; it passes with
`finalStandings`.

Also verified end to end: `scripts/e2e.ts` against `wrangler dev` still reaches
**25/25**, and its freshly finished 3-player game wrote places 1, 2 and 3 to
`game_players` (winner first, then the two eliminated players), read back with
`wrangler d1 execute --local`. The same local dev database still holds an older
3-player row set from before the fix with places 1, 2 and 4 — the gap this task
removes. That is stale local data, not something this build wrote.

Not verified: nothing is deployed, so places have only been observed in the
workers pool and against local `wrangler dev`, never live. A game state
persisted before this change has no `eliminationIndex`, so a player already
eliminated then would sort as if eliminated first; since nothing is deployed,
only local dev storage could hold such a state.

## Not started

Broken down as tasks **R1–R6** in the "Remaining work — handoff tasks" section
of `PLAN.md`, with per-task acceptance criteria. In short:

- **R1** — verify the UI in a real browser at a phone viewport. The client has
  never been rendered; all verification so far is protocol-level. Includes
  writing `scripts/bots.ts` so a human can play against bot seats.
- **R2** — write `README.md` (currently 0 bytes).
- **R3** — `wrangler deploy --temporary`.
- **R4** — verify the live URL (harness + browser).
- **R5** — redeploy into the same cached account; prove D1 and DO state survive.
- **R6** — strip any provisioned resource IDs, audit for leaks, hand-over report.

R3–R6 are time-coupled: the claim URL expires 60 minutes after R3 creates it.

A code review at `fc507d3` added tasks **B1–B10** in the same file, and
reviewing B1's fix added **B11**. `PLAN.md` opens with a **status board** —
that table is the authoritative list of what is left, and a task counts as done
only once it has been reviewed.

**B1 is done** (`ea28513`, reviewed). **B2 is fixed** (awaiting review);
**B3–B5 are still pre-deploy**: a lost result write on a transient D1 error, a
frozen turn countdown, and a host who closes their tab leaving the table
permanently unstartable.

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
