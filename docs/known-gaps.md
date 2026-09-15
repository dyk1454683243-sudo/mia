# Known gaps and deliberate limits

This page is the honest part of the documentation: what is missing on purpose,
what is missing by omission, and what is still open. If something here is being
removed without being replaced by a better answer, that is a decision to make
explicitly.

## Deliberately not in scope

These are known, intentional and should not be "fixed" mid-task without a
decision to change the product:

- **The 60-second turn timer is not exercised end to end.** The harnesses always
  act before it expires, so the real interaction between a running alarm and a
  live socket is never driven. Its behavior is covered deterministically in
  `test/room.test.ts` with a fast clock and a direct alarm invocation. The code
  path is tested; the wall-clock integration is not.
- **The double-Mia penalty is reported, not asserted.** `scripts/e2e.ts` counts
  the observed `double-mia` penalties and prints them, but does not require one,
  because whether the trap occurs in a given game is luck. The rule itself is
  pinned deterministically in `test/mia.test.ts`.
- **There is no rate limiting and no abuse protection beyond the 8-seat cap.**
  The cheaper amplifications were closed: `ping` replies to its caller instead of
  broadcasting to every socket, the new-player ship-name scan is bounded, and
  cross-site writes are rejected on `Sec-Fetch-Site`. None of that is a rate
  limit. This is a low-stakes demo with no accounts and no value at stake, and
  that is the stated trade-off rather than an oversight.
- **A table is single-use.** `handleStart` refuses once a round has begun, so
  there is no rematch; the finished screen says so, but the only path forward is
  the lobby. This is reasonable, but it is a product choice that a player will
  notice.

## Behaviors that are allowed rather than blocked

- **A late joiner stays connected and watches.** Joining a started game sends an
  error and the current snapshot, but the socket is not closed, so the player
  keeps receiving broadcasts as a spectator. The behavior is intentional; the
  error now tells them they are watching rather than leaving them to guess.
- **A pre-game table with no creator connected can be started by anyone seated.**
  This is the abandoned-host case: refusing would brick the table. The creator,
  while present, is still the only one who may start.

## Seams that will hurt if ignored

- **The persisted `MiaState` has no versioning and no migration.** The shape has
  already changed once, when `eliminationIndex` was added, and a room persisted
  before that change continues to load. It degrades gracefully — standings stay
  dense and the winner is right — but only because the reader was made tolerant
  (`?? 0` in the sort, `!= null` when counting). The next shape change has to make
  the same allowance, and a game that starts before a deploy and finishes after it
  is the case to test.
- **The result-retry give-up is the end of the data.** After the 6-hour window the
  object logs the recoverable payload and stops trying; if nobody reads the logs,
  the game is gone. That is the deliberate bound on a durably broken D1, but it
  means log retention is part of the recovery story.
- **The stale-move stamp is strict equality on `logSeq`.** Correct today because
  nothing bumps the log during a player's own turn. Any future event pushed
  mid-turn would begin refusing legitimate moves.

## Open

- **Intermittent reveal wedge — [issue #16](https://github.com/hensleyl/mia/issues/16).**
  Twice seen, never reproduced: once the e2e harness sat in `revealing` for 30
  seconds, and once the test that pins "an auto-played reveal resolves into the
  next round" flaked. They may be the same server bug or one may be a test-harness
  race. The issue records the two hypotheses and the one assertion that tells them
  apart, and the suggested next step is a rate measurement on a Linux matrix
  rather than another single run. A game that freezes mid-reveal is invisible to a
  player until they give up, which is why it is worth keeping open rather than
  dismissing as noise.
- **The isolated-storage flake is resolved, not merely rare.**
  [Issue #12](https://github.com/hensleyl/mia/issues/12) was the
  `Expected .sqlite, got …sqlite-shm` teardown failure. The assertion behind it
  does not exist in `@cloudflare/vitest-pool-workers` 0.22.0 — the storage model
  changed to per-test-file isolation — so the failure has no code path left to
  come from. That is a structural argument rather than a measured rate; the same
  Linux matrix that would measure #16 is what would turn it into a number.
