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

## Fixed: B5 — a host who closed their tab bricked the table

`afterDisconnect` never touched the roster, so a player who closed their tab or
lost signal stayed in it as a ghost. Pre-game that was fatal: `handleStart`
requires the opener to be `players[0]`, so a ghost in that seat meant nobody
could start and the table sat in the lobby advertising phantom players.
`afterDisconnect` also never called `syncTableRow`, so the D1 `player_count` the
lobby renders was stale after any disconnect.

- `webSocketClose` and `webSocketError` now hand the closing socket and its
  player id to `afterDisconnect`, which drops the seat through a shared
  `removePreGameSeat` (now also used by `handleLeave`) whenever the game has not
  started (`round === 0`), then syncs the D1 row.
- A player with another socket still open keeps the seat: the closing socket is
  excluded explicitly, so closing one of two tabs is not a disconnect.
- Mid-game nothing changes. The seat stays and auto-play covers the dropped
  phone, exactly as before.
- Host reassignment falls out of removal — the ghost leaves the roster, so
  `players[0]` is a connected player and the table is startable again. No
  separate host pointer was added, and `handleStart` keeps its strict
  "the opener starts" rule, with a comment saying why that is now safe.

One correction to the acceptance's arithmetic: it asks for "two players join,
the host's socket closes, the remaining player can start". With two seats total
that leaves one player, and the ruleset needs two to start — so the test uses
the host plus two others, which is the case where starting must work. A two-seat
table whose host leaves is correctly unstartable, not a bug.

Verified: `npx vitest run` **62 passing (45 unit + 17 workers)**; both typechecks
clean; `scripts/e2e.ts` **25/25** (its mid-game reconnect against live
`wrangler dev` is the closest thing it has to a disconnect check). New workers
tests:

- the host closes their tab on a three-seat table; the roster becomes the other
  two, the D1 `player_count` follows it to 2, and the next player can start;
- a pre-game player with a second socket open keeps their seat when one tab
  closes and loses it only when the last one does;
- a mid-game disconnect keeps the seat, leaves `player_count` at 2 and the table
  `playing`;
- an abandoned pre-game table — one seat, nobody else joined, tab closed — is
  reaped past a shortened TTL with no alarm left behind.

Both new seat behaviours were checked against the old code: stubbing
`removePreGameSeat` back to a no-op fails the host test (the roster never drops
to two, so nothing can start) and the reap test (the ghost holds
`player_count` at 1).

Not verified: none of this has been seen in a browser. Closing a real tab is a
browser action, and R1 is the task that will actually do it at a phone viewport.
Nothing is deployed.

## Done: R1 — the UI in a real browser, at a phone viewport

The client had never been rendered. It now has been, at 375×812 and 768×1024, in
headless Chromium driven by Playwright, playing a full game against bots.

**Tooling.** `playwright` is a devDependency; the browser bundle is downloaded on
demand into `.playwright-browsers/` (gitignored):

```
npm install
PLAYWRIGHT_BROWSERS_PATH=$PWD/.playwright-browsers npx playwright install chromium
```

`scripts/lib.ts` is new: the WebSocket `Client`, `createPlayer`, `api`,
`makeRandom`, `chooseAction` and `nextSnapshot` moved out of `scripts/e2e.ts`
verbatim, so both harnesses share them (`e2e.ts` was rewritten to import them and
is otherwise unchanged). `scripts/bots.ts <tableId> [count]` seats bots at a
table, waits for the human to start the game, plays every non-human seat, and
stays attached afterwards so the finished table keeps its seats. `scripts/ui-check.ts`
drives the real browser: lobby, share, a full game, reconnect, phone fitness and
console capture, writing screenshots to `.r1-screenshots/` (gitignored).

**Defects found and fixed.**

1. **The active player had no countdown.** `secondsLeft` was only rendered in the
   "Waiting for …" line, so whoever had to act could not see their own clock.
   The active player's row now carries a countdown badge. The same change fixes
   the follow-up the B4 review flagged: the 500ms interval now writes the
   `[data-countdown]` text nodes instead of calling `render()`, so ticking no
   longer replaces the whole page every second.
2. **The verdict line printed Mia as "2·1".** `verdictLine` used `formatValue`
   while the chips used a MIA label — the same claim read as "MIA" above and
   "2·1" below. One `valueLabel` helper now labels every announcement in prose.
3. **The announce grid's "yours" marker missed half of all rolls.** It computed
   `dice[0] * 10 + dice[1]` instead of `rollValue(...)`, so whenever the lower die
   came up first the truthful button was not marked. It now uses `rollValue`.
4. **The announce grid covered the table.** The 21-button actions card inherited
   `position: sticky; bottom`, and being taller than a phone viewport it overlaid
   the players list. That one card (`.actions-tall`) now flows normally; the
   measured overlap is 0px, and the compact decision card is still sticky.
5. **A roll over a standing claim could deadlock the game.** `legalMoves` allowed
   `canRoll` in `deciding` unconditionally, so with Mia standing the UI offered
   "Roll the dice". Rolling left the player in `announcing` with no legal
   announcement, and the server's auto-play had no move either — the permanent
   1 Hz loop B11 describes, reachable from the UI. `canRoll` is now true only
   when nothing stands, so the choice there is believe or doubt; regression tests
   in `test/mia.test.ts` cover both the Mia case and an ordinary standing claim.
6. `scripts/bots.ts` logged "announcees"; now "announces".

**Verified** (`node scripts/ui-check.ts` against `npm run dev`): **35/35 checks**
and **zero console errors or page errors**, including

- lobby: ship name, inline rename that survives a reload, open-table list, table
  creation, and the 4s poll leaving the rename field focused with its text and
  scroll position intact;
- share: `navigator.share` receives the `/t/:id` URL, the clipboard fallback
  copies it and shows its toast, and opening the copied link in a fresh browser
  context joins the table — then closing that context frees the seat again;
- a full game to a winner with every phase rendered, all 21 announce buttons
  above the standing claim, Mia distinct, the viewer's own roll marked "yours",
  and no other player's dice on screen before a reveal;
- a mid-game reload restoring the same round and phase with no duplicate seat;
- the countdown ticking 60 → 59 → 58 with the bots frozen (so no snapshot could
  legitimately re-render) while a tagged `.actions` node survived untouched;
- no horizontal scroll at 375px or 768px, and no tap target under 40px.

Screenshots (375×812 unless noted) live in `.r1-screenshots/`: `01-lobby`,
`02-table-waiting`, `02b-table-with-bots`, `03-fresh-session-join`,
`04-round-start`, `05-deciding`, `06-announcing`, `07-revealing`,
`08-finished`, `09-game-over`, `10-reconnect`, `11-wide-768`.

`npx vitest run` **63 passing (46 unit + 17 workers)**, both typechecks clean,
`scripts/e2e.ts` **25/25** after the `lib.ts` extraction.

**Not verified.** This is headless Chromium emulating a phone, not a real
handset: no iOS Safari, no real touch, no OS share sheet (`navigator.share` was
stubbed to inspect its argument), no slow network, and the countdown was watched
for three ticks rather than a whole 60-second turn. The finished-state countdown
and the losing/spectator view were not separately exercised. Nothing is deployed.

## Done: R2 — README.md

`README.md` was 0 bytes. It now covers what the game is and the exact plain
ruleset (with the three deliberately-omitted variants), the architecture and why
there is a Durable Object per table, install / run locally / test / deploy, the
project layout, and the sandbox prefixes.

Four npm scripts were added so the browser path cannot be forgotten and so the
harnesses are discoverable: `ui-setup`, `ui-check` (which carries
`PLAYWRIGHT_BROWSERS_PATH=$PWD/.playwright-browsers`), `bots`, and `e2e`.

**Every command in the README was run, not assumed:**

| command | result |
| --- | --- |
| `npm_config_cache=$PWD/.npm-cache npm install` | installs clean |
| `npm run types` | regenerates `worker-configuration.d.ts` |
| `npm run ui-setup` | browsers already present, nothing to download |
| `npm run dev` | build + vite watch + `wrangler dev` ready on :8787 |
| `npm test` | 63 passing (46 unit + 17 workers) |
| `npm run typecheck` | both projects clean |
| `npm run e2e` | 25/25 against `wrangler dev` |
| `npm run ui-check` | 36/36, zero console errors |
| `npm run bots -- <tableId> 2` | seated, waited for the human, played; 16 bot actions in the event log |
| `npx wrangler deploy --dry-run --outdir dist/worker` | bundles 7 files, exits |
| `XDG_… npx wrangler dev` (sandbox form) | ready, `/` returns 200 |

Two things surfaced while writing it:

- **A fresh clone could not typecheck.** `worker-configuration.d.ts` is
  gitignored, generated, and required by `tsc`; without it the typecheck fails
  with TS2688. Reproduced by deleting the file, and the README's install step now
  includes `npm run types`.
- **`scripts/bots.ts` was only reachable as a raw `node` command.** It is now
  `npm run bots -- <tableId> [count]`.

**Not run:** `npm run deploy` and `npm run deploy:temporary`. Creating the
temporary account is R3's job and temporary accounts are rate limited, so deploy
is documented and its packaging is verified with `--dry-run`; the real deploy is
R3. No account IDs, tokens or claim URLs appear in the README.

## Done: R3 — deployed to a temporary Cloudflare account

Deployed on **2026-09-13 at 16:43Z** with

```
XDG_CONFIG_HOME=$PWD/.cfstate XDG_CACHE_HOME=$PWD/.cfstate/cache npx wrangler deploy --temporary
```

run as a one-shot background job, non-interactively. Preconditions confirmed
first: wrangler 4.131.1 (≥ 4.102.0), `wrangler whoami` reporting **not
authenticated**, no ambient `CLOUDFLARE_*`/`CF_*` credentials, `npm test` 63
passing, `npm run typecheck` clean, and a clean working tree.

The deploy created a temporary account, provisioned the D1 database and the
Durable Object namespace from `wrangler.jsonc`, uploaded the 6 assets, and
printed a live `workers.dev` URL. **The live URL and the claim URL are delivered
in the chat message for this task only** — per the plan's handing-over rule they
are not written into any committed file. Same for the account name and the
claim deadline.

Verified live, immediately after deploy:

- `GET /` → **200**
- `GET /api/me` → **200**, JSON, with a signed `HttpOnly; SameSite=Lax; Path=/;
  Max-Age=34560000; Secure` `mia_pid` cookie — so the Worker, D1 and the
  session code are all live, not just the asset binding
- `GET /t/does-not-exist` → 200 (the table page; the id lookup is the API's job)
- `GET /api` → 200, i.e. the bare `/api` path reached the Worker rather than the
  asset binding

`git status` is **clean** and `git diff wrangler.jsonc` is **empty**: the
auto-provisioning did not write a `database_id` or any other account-specific ID
back into the committed config, so it can still deploy into a fresh account.

**Not verified here** (R4/R5 own them): the 25/25 e2e harness against the live
URL, any browser run against it, and persistence of D1 rows and Durable Object
state across a redeploy.

**Timing.** The claim window is 60 minutes from the moment the temporary account
was created (between 16:43:13Z and 16:43:41Z), so the deadline is approximately
**17:43Z UTC**. R4–R6 must run before it.

## Done: R4 — verified the deployed URL

Against the live deployment (URL in R3's chat message).

**Protocol harness — 25/25, same as local.** `MIA_BASE=https://… node scripts/e2e.ts`:
identity and the signed cookie, table creation, a full 15-round game with 14
reveals and one double-Mia, hidden dice never leaked, a caught bluff and a
failed doubt both charged correctly, a single winner, the `tables` row flipped to
`finished`, the game and its three per-player rows in live D1 via `/api/history`,
every error path, and a mid-game reconnect that restored the round, phase and cup.

**Error paths on the live URL, explicitly:** unknown table **404**, over-long
rename **400**, malformed JSON **400**, control-characters-only rename **400**,
`DELETE /api/me` **405**, `PUT /api/tables` **405**, bare `/api` **200** (reached
the Worker, not the asset binding), and an unknown path **404** — no SPA fallback
swallowing it into an HTML 200.

**Browser — 35/35, zero console errors.** `MIA_BASE=https://… npm run ui-check`
with `MIA_UI_OUT=.r1-screenshots/live`: lobby rename, both share paths, a
fresh-session join, a full game against `scripts/bots.ts` with every phase, no
leaked dice, the countdown ticking without a per-second re-render, a mid-game
reload, no horizontal scroll at 375px or 768px, and no console or page errors.
Screenshots are in `.r1-screenshots/live/` (the lobby shot shows the harness's
own tables in the live directory, which is how you can tell it is not local).

**This wrote real rows into the live D1**, as the task said it would: one
finished game with three per-player rows, plus the tables the harness and the
browser check created. The harness's `Reconnect table` is left `playing` and
will drop out of the lobby after the 30-minute staleness window. Nothing was
cleaned up, and `hostName` still reads `"someone"` (the documented dead field).

**Anything different from local?** Nothing in behaviour. Specifically:

- **Timing.** Live requests carry real edge latency but no timeout was
  approached; both games ran at the same pace as local (15 rounds, 14 reveals).
- **Alarms.** The reveal (5s) and round-start (2s) beats fired throughout both
  live games, so the single-alarm design works deployed, not just in miniflare.
  The 60-second turn clock was never reached live either — actions were always
  prompt — so its auto-play path remains covered only by `test/room.test.ts`.
- **Hibernation.** Not directly observable from a client and not forced: the
  longest idle window was the browser check's ~4s bot freeze, below the eviction
  threshold. Nothing misbehaved across the reconnect, which is the closest
  signal available.
- **Edge propagation.** No `error code: 1042` or other post-deploy error page;
  the URL answered 200 immediately.
- **Fresh D1.** The live database was created by the deploy, so the lazy
  `ensureSchema` ran on the very first live request; it worked.

## Done: R5 — redeployed and proved persistence

Two redeploys into the same temporary account, both with the same command.

**The account was reused and the bindings inherited** (quoted from the deploy
output of the first redeploy):

```
Temporary account ready:
	Account: Irradiated Methane (reused)
...
Binding                     Resource
env.DB (inherited)          D1 Database
```

A fresh version ID each time (`5a9fd3e1…`, then `64ec77ae…`, then `2f50cac9…`)
and the same `workers.dev` URL, so the cache survived — the claim URL from R3 is
still the one that owns the account.

### D1: identical before and after

The finished game from R4, `mu022dhg-3de0f3c3`:

| field | before redeploy | after redeploy |
| --- | --- | --- |
| winner | Zero Gravitas | Zero Gravitas |
| started / finished | 1789318550212 / 1789318669515 | same |
| place 1 | Zero Gravitas, 2 lives, 15 rounds | same |
| place 2 | Ultimate Ship The Second, 0 lives, 15 rounds | same |
| place 3 | Not Invented Here, 0 lives, 11 rounds | same |

Its `tables` row was also byte-identical: `status finished`, `playerCount 3`,
`updatedAt 1789318669560`. `/` still returned 200.

### Durable Object: the live game survived

A fresh three-player game was started, played into round 2, and the *last move
was made immediately before the redeploy* so a fresh clock was armed and nothing
could auto-play inside the window:

```
[R5] before redeploy : {"round":2,"phase":"roundStart","lives":"Resistance=6 You'll=6 Charitable=5",
                        "cup":"-","turn":"e268c48f…","logSeq":10}
[R5] after  reconnect : {"round":2,"phase":"deciding",  "lives":"Resistance=6 You'll=6 Charitable=5",
                        "cup":"-","turn":"e268c48f…","logSeq":10}
[R5] phase roundStart -> deciding (roundStart->deciding is the 2s beat)
[R5] PASS — same round, logSeq, lives, cup and turn after the redeploy
```

Round, `logSeq`, every player's lives, the cup and the turn holder are all
identical. The only change is `roundStart → deciding`, which is the server's own
2-second beat firing while the redeploy ran — the game is live, so that is
expected, not drift.

The first attempt at this went differently and is worth recording: I left a 20s
idle before redeploying, and during it the 60-second clock auto-played a doubt,
resolved the round and started the next one — so the before/after comparison
showed `round 2 → 3` and a lost life. That is the timer working, not a
persistence failure; the test window was simply too long.

### One flake found in the harness (recorded, not fixed here)

`playGame` in `scripts/e2e.ts` connects its clients with `Promise.all`, so
against a live account the D1 host is not reliably the Durable Object's first
seat. Twice here the server then correctly refused the start with *"Only the
player who opened the table can start."*, because whoever connected first owned
seat 0. It is the B10 host-identity mismatch showing up in test infrastructure.
The R5 script connects sequentially instead; the one-line fix for the harness is
the same. Every published e2e run (local and live, R1–R4) happened to win that
race.

## Done: R6 — config hygiene, leak audit, hand-over

**Config.** `wrangler.jsonc` contains no `database_id`, `preview_database_id`,
`account_id` or `zone_id` — nothing was written back by the four deploys.
`git status` is clean and `git diff wrangler.jsonc` is empty. A
`wrangler deploy --dry-run` parses the committed config, so it will still deploy
into a *fresh* account; the temporary account was `(reused)` every time, so a
second one was never created.

**Leak audit.**

- `git ls-files` contains nothing under `.cfstate/`, nothing under `.dev.vars`,
  and no `claim*` path; no path under either has ever appeared in
  `git log --all --name-only`.
- Across every tracked file, and across the full `git log --all -p`, there are
  **zero** occurrences of the temporary account name, the live host name or the
  claim token.
- The one `claim-preview` string in the repository is a generic placeholder
  inside the bundled Cloudflare skill doc
  (`.agents/skills/cloudflare-temporary-accounts/SKILL.md`), which predates this
  work and contains no real credential.

**Hand-over.** The live URL, the claim URL framed as a bearer credential with
its absolute UTC deadline, the consequence of not claiming, and the honest
verified / not-verified list are delivered in the R6 chat message and in **no
file** — per the plan's handing-over rule. This file deliberately contains none
of them.

## Fixed: B12 — the creator was locked out of starting their own table

Found on the live deployment during the R3–R6 review and **not reproducible
locally**: `handleStart` treated `state.players[0]` as the host, and the
Durable Object's roster is in WebSocket arrival order. Locally sockets arrive in
microseconds and effectively in issue order, so the creator always won; over a
real network, whoever opens the link first owns seat 0. The creator was then
told *"Only the player who opened the table can start"*, which was false, and
the friend could start instead.

D1 already knew the truth — `tables.host_id` — so one layer is now authoritative:

- **Worker** (`src/worker/index.ts`): the WebSocket upgrade already looked the
  table row up, so it forwards `X-Mia-Host-Id` from `table.hostId` alongside the
  existing `X-Mia-*` headers.
- **State** (`src/shared/mia.ts`): `MiaState.hostId` holds the creator.
  `newLobbyState` takes it from the header (falling back to the first socket only
  if the header is absent) and `handleConnect` backfills it with `??=`, so a
  room persisted before this change learns it on the next connect — the
  no-state-versioning hazard the B2/R5 reviews flagged, handled rather than
  assumed.
- **`handleStart`** (`src/worker/table-room.ts`) compares against
  `state.hostId`, not the roster. A non-creator is refused **by name**
  (`Only <name> can start this table.`). If the creator is **not connected**,
  anyone seated may start — B5's case, preserved exactly.
- **Client** (`client/src/table.ts`): the waiting room now derives the host from
  `view.state.hostId`, so the creator sees the start button even when they are
  not seat 0, the "opened" badge marks the real creator, a non-creator is told
  *"Waiting for &lt;creator&gt; to start…"*, and when the creator is away it says
  *"The table's creator is away — anyone here can start it."*
- **Harness** (`scripts/e2e.ts`): `playGame` now connects sequentially,
  creator-first, so the live-style ordering is exercised instead of raced. This
  is the flake R5 hit and recorded.

Verified:

- Two new workers tests: *"lets the creator start even when someone else
  connected first"* (the friend is asserted to be seat 0, is refused by name, and
  the creator then starts) and *"lets anyone start once the creator has gone"*
  (B5 preserved); the pre-existing start-refusal test now asserts the message
  names Anna.
- The B12 test was confirmed to fail against the old logic: computing the host
  from `state.players[0]` makes it time out, because the friend owns seat 0.
- `npx vitest run` **65 passing (46 unit + 19 workers)**, both typechecks clean,
  `vite build` clean.
- `npm run e2e` **25/25** with the sequential connect.
- `npm run ui-check` **40/40**, zero console errors. Five of those are new: a
  second browser context opens the link first, so the friend is genuinely seat 0,
  and it asserts the creator sees the start button, the friend does not, the
  waiting line names the creator, and the creator can start the game. Screenshot
  `12-creator-started.png`.

Not verified: nothing new against a live deployment — the temporary account from
R3 was disposable and its claim window had closed by the time B12 was fixed, so
this is a local (workerd + Chromium) verification. The workers test drives the
real Worker and Durable Object through `SELF.fetch`, and the browser check
drives the real client, which is the same coverage R4 had minus the edge.

Found in passing while reading the B12 screenshot (recorded for **B10**, not
fixed): the local dev D1 now holds **359 players against a 61-name pool**, so
`pickShipName` has fallen back to reusing names and two seats can share one —
which is why that screenshot shows both players as "Of Course I Still Love
You". That is the documented fallback rather than a regression (a fresh
database avoids collisions), and it is the same `listPlayerNames` scan B10
already flags as unbounded.

## Not started

Nothing. **R1–R6, B1–B11's pre-deploy fixes and B12 are all done.** R3–R6 and
B12 await review; the live credentials for the temporary deployment are in the
R6 chat message (and that account is disposable).

R3–R6 are time-coupled: the claim URL expires 60 minutes after R3 creates it.

A code review at `fc507d3` added tasks **B1–B10** in the same file, and
reviewing B1's fix added **B11**. `PLAN.md` opens with a **status board** —
that table is the authoritative list of what is left, and a task counts as done
only once it has been reviewed.

**B1** (`ea28513`), **B2** (`07fb73e`), **B3** (`eb8d1db`), **B4** (`c0f396b`)
and **B5** (`083a695`) are done and reviewed — every pre-deploy code fix is
complete. **R1** (`255fa5b`) and **R2** (`d11809d`) are done and
reviewed. All that remains is the time-coupled deploy series **R3–R6**, which
has to run back to back because the claim URL expires 60 minutes after it is
created. Screenshots from R1 are not committed (binary artifacts); regenerate
them with `npm run ui-check`.

### Review of R2 (`d11809d`) — approved

I tested the acceptance criterion literally: cloned the repo to a fresh
directory and followed the README as a stranger would. `npm install` →
`npm run types` → `npm run typecheck` → `npm test` all succeed from nothing but
the README, 63 tests passing. Deleting the generated `worker-configuration.d.ts`
reproduces the TS2688 the README cites, so its reason for the `npm run types`
step is accurate rather than assumed. Also verified: `npm run e2e` 25/25,
`npm run ui-check` 35/35 (`$PWD` does expand inside an npm script),
`npm run bots -- <id> 2` seats two bots, and `wrangler deploy --dry-run` builds.
No claim URL, token or account id anywhere in the file.

Both review notes were then applied to the README directly:

- The doubt-resolution bullets now say to compare by **position in the ranking
  table, never arithmetically**, with `66` and `11` both beating a claimed `65`
  as the worked examples (checked against `outranks` — treating it as arithmetic
  is exactly the bug fixed in the first commit). `PLAN.md`'s ruleset, where the
  phrasing originated, is corrected the same way.
- The npm 11 install-script warning is now called out as expected and safe to
  ignore.

Three further edits for clarity: a two-line quick start under the intro, so
running it does not mean scrolling past the whole ruleset first; the
Durable-Object rationale tightened; and the omitted *variants* separated from
the wider product decisions (no chat, no accounts) they were mixed in with.

R3–R6 are all done. The live URL, claim URL and deadline live in the R6 chat
message only, never in a file, and expire 60 minutes after the temporary account
was created.

### Review of R1 (`255fa5b`) — approved

Independently confirmed: I re-ran `ui-check` myself (36/36 — the count is
game-dependent, so 35 is not a fixed expectation), re-ran `scripts/e2e.ts` after
the `lib.ts` extraction (25/25), drove `scripts/bots.ts` standalone against a
fresh table (two bots seated, `player_count` 2, waiting for a human), read the
generated screenshots, and confirmed 63 tests with both typechecks clean. The
page is genuinely good on a phone, and defects #2 and #3 are visibly fixed in
the reveal and announce-grid screenshots.

Defect **#5 was game-breaking and I reproduced it directly**: with a roll forced
over a standing Mia, every flag in `legalMoves` is false and `autoPlaySequence`
returns `[]` — a total deadlock, one UI click away whenever anyone announced
Mia. The fix is the correct rule (only the round opener rolls) and is enforced
server-side, not merely hidden in the UI. This also proves **B11**'s 1 Hz alarm
loop was reachable in ordinary play rather than theoretical, as that task had
assumed; B11 is updated.

One reproducibility defect: `node scripts/ui-check.ts` as documented **fails** —
the browsers live in `.playwright-browsers/`, so every run needs
`PLAYWRIGHT_BROWSERS_PATH=$PWD/.playwright-browsers`. The install line carries
the variable but the run line does not. R2 now owns adding npm scripts so it
cannot be forgotten.

### Review of B5 (`083a695`) — approved

Independently confirmed: 62 tests pass (45 unit + 17 workers), both typechecks
clean, e2e 25/25. Three mutations each break the right tests — a no-op
`removePreGameSeat` breaks the host, two-tab and pre-game-reap tests; an
always-false `hasOtherSocket` breaks the two-tab test; dropping the `round > 0`
guard breaks the mid-game test *and* B3's result-write test, which shows the
suites interlock. Excluding the closing socket explicitly is correct whether or
not the runtime has already dropped it from `getWebSockets()`.

The task's acceptance criterion was wrong as written — one player cannot start a
game — and the author caught it, used three seats, and explained why rather than
following it blindly.

Two follow-ups recorded in `PLAN.md` (**B10**): a reaped table's D1 row is still
never marked abandoned, so the lobby lists it until the 30-minute staleness
filter hides it; and now that a disconnected pre-game seat is dropped,
`players[0]` is routinely not the opener, making "Only the player who opened the
table can start" actively misleading.

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

## Review of R3–R6 — approved, with one live-only bug found

Verified independently against `https://mia.irradiated-methane.workers.dev`:

- **Health and routing.** `/` and `/t/:id` 200 HTML, `/nonexistent` a real 404
  (no SPA fallback), the session cookie carries `Secure` over HTTPS.
- **Live D1.** `/api/history` returns recorded games whose places read `1, 2, 3`
  — B2's fix holding in production, on data written by the deployed Worker.
- **Protocol harness** against the live URL: **25/25**.
- **Browser** against the live URL at 375×812: **35/35**, a full game against
  bots, zero console errors, the countdown ticking without a per-second
  re-render, redaction holding, and phone fitness at 375px and 768px.
- **Leak audit re-run independently.** No claim token, API token or account id
  in the tree or anywhere in history; nothing under `.cfstate/` tracked; no
  `database_id` or `account_id` in `wrangler.jsonc`. The single `claim-preview`
  string is the `<TOKEN>` placeholder in the vendored skill docs.

**But R4's claim of "no behavioural difference from local" is wrong**, and the
difference is a user-facing bug — now **B12**. My first live harness run
*crashed*: `Only the player who opened the table can start.` The Durable Object
treats `players[0]` — WebSocket **arrival order** — as the host, while D1
records the real creator, and nothing reconciles them. Connecting the second
player first reproduces it 3 times out of 3 on the live URL: the creator is
refused, and the friend who merely opened the link can start the table.

Locally the sockets connect in microseconds in issue order, so the creator
always wins the race; over a real network the order is arbitrary. A second live
run then passed 25/25 — so R4's result was real but **a coin flip**, and a
single green run was never evidence here. `scripts/e2e.ts` compounds it by
connecting its clients with `Promise.all` and assuming `clients[0]` is the host;
it should connect the creator first.

This is the same divergence B10 listed and the B5 review downgraded to "a
misleading error message". That downgrade was mine and it was wrong: it blocks
the creator from starting their own table.

## Review of B12 (`4f858ce`) — approved, validated on a fresh deployment

D1's `tables.host_id` is now authoritative: the Worker forwards
`X-Mia-Host-Id` on the upgrade, `MiaState` carries `hostId` (backfilled with
`??=` for rooms persisted before the change), and `handleStart` compares
against it, keeping B5's rule that a table is not blocked by an absent creator.

Verified independently:

- 65 tests pass, both typechecks and `vite build` clean.
- Reverting `handleStart` to `players[0]` breaks exactly the new test.
- The scenario that failed 3/3 before — friend connects first — now passes
  **3/3 against a live deployment**, with `e2e` 25/25 against it.
- **Forgery attempt refused.** The fix moves authority onto a request header, so
  a client sending its own `X-Mia-Host-Id` and `X-Mia-Player` was tried: the
  Worker's `.set()` overwrites both and the attacker is told who the real
  creator is. Worth remembering for any future header the DO trusts.

The old temporary account had lapsed, so this ran on a fresh one — the
disposable-deployment path working as intended. `wrangler.jsonc` was not written
back to (the only `database_id` match is the comment saying there is none), and
the tree stayed clean through the deploy.

**Live now: `https://mia.malleable-gum.workers.dev`** (unclaimed and disposable;
it will stop working when the account lapses, and the fix for that is another
`npm run deploy:temporary`).

One consequence to keep in view: `scripts/e2e.ts` now connects creator-first and
no longer exercises the racy ordering, so it can no longer catch a B12
regression. The dedicated workers test and `ui-check`'s two browser contexts are
what cover it.
