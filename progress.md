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

## Fixed: B3 — a failed result write was lost

`writeResults` caught a D1 failure and left `resultsWritten` false with a
comment claiming the next load would retry. Nothing ever did: `writeResults` ran
only from `commit`, and no commit follows game over. Worse, the constructor
*inferred* `resultsWritten` from `state.gameOver !== null`, so a restart after a
failed write marked the result as already written and lost it for good.

- **Written is now its own persisted fact.** A `resultsWritten` key goes down
  only after D1 has taken the rows, and the constructor reads it instead of
  guessing from `gameOver`. Absent means "retry", which is safe because
  `recordGame` is idempotent.
- **Retry on the alarm, with backoff.** A failure arms `resultsRetryAt`
  (1s, 2s, 4s … capped at 5 minutes) and schedules it. `alarm()` handles a
  pending result *first*, ahead of the phase dispatch and the reaper, and the
  failure path arms the alarm directly too, because `applyAndContinue` returns
  on game over without reaching `ensureAlarm`.
- **Load-time retry.** The constructor cannot do network I/O under
  `blockConcurrencyWhile`, so it arms an immediate alarm instead and the next
  `alarm()` performs the write. That is the "attempt the write on DO load" the
  task asked for.
- **The reaper defers to it.** `ensureAlarm` and `maybeReapEmptyRoom` both
  refuse to collect a finished room whose result is unwritten: the write is
  attempted first and only a success lets the room be reaped. This is the B1
  interaction the task called out.
- `syncTableRow("finished")` now rethrows so a failed `tables` update keeps the
  retry alive rather than leaving the lobby advertising a finished table; the
  routine lobby syncs still swallow errors exactly as before.

A sustained outage is retried forever at the 5-minute cap rather than giving up
— the result is the only copy of the game — and every attempt is logged.

Verified: `npx vitest run` **54 passing (41 unit + 13 workers)**; both
typechecks clean; `scripts/e2e.ts` **25/25** against `wrangler dev`. New workers
tests:

- the backoff grows 1s → 2s → 4s and caps at 5 minutes;
- a game whose write fails twice is retried on the real alarm clock, and the
  result rows plus the `finished` table row land on the third attempt;
- a room already past its empty TTL is not deleted while its result is
  unwritten (a direct reap attempt is refused), and the write completes once
  D1 recovers;
- after `state.abort()` evicts the object, the reloaded room still reports the
  pending result, arms its own alarm, and writes it on the next wake.

Each of the three behaviour tests was checked to fail against the code it
replaces: removing the retry arming, removing the reaper guard, and restoring
the old `resultsWritten = gameOver !== null` load line each break their test.

Not verified: nothing is deployed, so this has only been exercised in the
workers pool and against local `wrangler dev`. The failures are injected through
private `resultWriteFailures` / `resultWriteAttempts` fields poked from the
test — the same pattern B1's `emptyTtlMs` uses — not by failing a real D1
binding. Both fields are extra test-only surface in the DO for **B9** to clean
up.

## Fixed: B4 — the turn countdown never counted down

`secondsLeft` measured the client/server drift and used it in the same
expression, so `deadline - (Date.now() - (Date.now() - serverTime))` collapsed to
`deadline - serverTime` — a constant for the life of a snapshot. The 500ms
interval in `table.ts` re-rendered, but always with the same number, so a
60-second turn sat still and then jumped when the next broadcast landed.

- The countdown is now a small pure `TurnClock` in a new `src/shared/clock.ts`.
  Its `sync(serverTime)` is the **only** place the drift is measured — once per
  snapshot — and `secondsLeft(deadlineAt)` evaluates against a live `Date.now()`
  on every call.
- `table.ts` keeps one clock, calls `clock.sync(view.serverTime)` in the
  socket's `onState`, and reads `clock.secondsLeft(view.deadlineAt)` in both the
  render and the interval, so the displayed value falls between broadcasts.
- The old `secondsLeft` in `client/src/net.ts` is gone. The new module is pure
  (no DOM, no Cloudflare imports) so it unit-tests in plain Node; both
  typechecks and the browser build cover it.

Verified: `npx vitest run` **58 passing (45 unit + 13 workers)**; both
typechecks clean; `vite build` clean; `scripts/e2e.ts` still **25/25**. The
harness is protocol-level and never loads the page, so it cannot exercise this
fix — it is a non-regression check only. New `test/clock.test.ts` unit tests, on
a mocked clock:

- from a single `sync`, the value falls 60 → 59 → 30 → 1 → 0 across ticks, with
  no further snapshot, and never goes negative;
- a client clock five minutes ahead or five minutes behind still counts down at
  the right rate;
- a fresh snapshot re-measures the drift and adopts the new deadline;
- a null deadline yields null.

The first test was confirmed to fail against the original arithmetic: with the
drift re-derived inside the countdown it reports a constant 60 instead of 59.

Not verified: nothing renders this in a browser yet. R1 is the task that
actually puts the table page on screen at 375×812, and the countdown belongs on
its checklist. Nothing is deployed, so there is no live countdown either.

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

**B1** (`ea28513`), **B2** (`07fb73e`), **B3** (`eb8d1db`) and **B4**
(`c0f396b`) are done and reviewed. **B5 is the last pre-deploy item**: a host
who closes their tab leaving the table permanently unstartable.

### Review of B4 (`c0f396b`) — approved

Independently confirmed: 58 tests pass (45 unit + 13 workers), both typechecks
and `vite build` clean, e2e 25/25. Reproducing the original arithmetic
faithfully — storing `serverTime` and re-deriving the drift on each call —
breaks three of the four new tests and reports exactly the constant 60 the
author described. The write-up is candid that e2e is protocol-level and cannot
exercise a client-only fix.

One follow-up, added to **R1**'s checklist rather than fixed here: making the
countdown tick **activated a once-per-second full-page re-render**. The interval
re-renders whenever the integer changes, which previously meant about once per
snapshot because the value never moved; it now means every second of every turn,
and `render()` replaces the whole page via `app.innerHTML`. No inner scroll
containers exist to reset, so this needs eyes rather than a fix on
principle — but text selection, CSS transitions and in-flight taps are
discarded each second on a phone. Nobody has yet seen this page in a browser.

### Review of B3 (`eb8d1db`) — approved

Independently confirmed: 54 tests pass (41 unit + 13 workers), both typechecks
clean, e2e 25/25. I re-ran the author's three mutations and got the same result
they reported — restoring `resultsWritten = gameOver !== null`, removing the
reaper guard, and removing the retry arming each break exactly one test. The
mechanisms are pinned individually this time, not just the outcome, and the
reap test invokes `maybeReapEmptyRoom` directly instead of relying on an outer
path. Finding the constructor's `gameOver`-inference bug, which the task had
not identified, is the sharpest part of the fix.

Two follow-ups recorded in `PLAN.md` rather than fixed here: a durably broken
D1 now keeps every finished table alive forever, retrying at the 5-minute cap
and never reaped — a deliberate trade-off the author flagged, bounded in
**B11**; and the idempotency claim is never exercised, because the fault
injection throws before `recordGame`, so only total failures are covered
(**B10**).

### Review of B2 (`07fb73e`) — approved

Independently confirmed: 50 tests pass (41 unit + 9 workers), both typechecks
clean, e2e 25/25, and the workers test genuinely fails when the seat-index
formula is restored. Places written by a live run read back dense (1, 2, 3).

One follow-up, recorded in `PLAN.md` rather than fixed here: `eliminationIndex`
is the first change to the persisted `MiaState` shape and there is no state
versioning. Old-shaped records degrade gracefully — standings stay dense and the
winner is right — but the next-index counter treats `undefined` as
already-indexed and inflates. Logged in **B10**, with a caution added to **R5**,
the step that actually redeploys across a live game.

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
