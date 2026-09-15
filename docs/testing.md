# Testing

The suite runs in two different runtimes, and the split is the point.

`vitest.config.ts` defines two projects:

- **`unit`** runs in plain Node with no Workers runtime. It covers the pure rules
  engine, the clock arithmetic and the seat-limit constants. These are the tests
  that can be reasoned about from the code alone, and they run fast because there
  is no platform underneath them.
- **`workers`** runs inside `workerd` with a real D1 database and a real Durable
  Object. It covers the Durable Object and the HTTP API. These are the tests that
  need the actual storage and socket behavior, because a mock of a Durable Object
  would not prove anything about how one behaves.

The engine tests avoid Cloudflare imports entirely, which is what makes the first
project possible. If a rule becomes untestable in plain Node, that is a signal
that a platform concern has leaked into the wrong module.

## Tests drive a subclass, production ships the real class

`test/worker-entry.ts` exports the production handler plus `TestTableRoom`, and
`vitest.config.ts` binds that subclass as `TABLE`. The production entrypoint
(`src/worker/index.ts`) does not import or export any of it, so a deployed bundle
has no seam in it.

The seams on `TestTableRoom` are the operations a test needs and a user must never
have:

- `__setDiceForTest` plants dice in front of a player, so a specific bluff or a
  real Mia can be driven deterministically.
- `__stateForTest` reads the unredacted server state.
- `__setTimingsForTest` shortens the clock, so the turn, reveal and round beats can
  be exercised in milliseconds instead of minutes.
- `__failResultWritesForTest` and `__failFinishedSyncForTest` make D1 fail, and
  `__setResultRetryWindowForTest` shortens the give-up window.

Production does consult two `protected` hooks, `shouldFailResultWrite` and
`shouldFailFinishedSync`, both of which return `false` and exist only to be
overridden. That is a deliberate improvement over putting a test counter in the
real write path: the check on a real write is now an always-false hook rather than
a field a test could reach.

This arrangement is worth stating because the natural alternative is worse. Public
`__*ForTest` methods on the exported class are unreachable only as long as no
future route forwards a method name, and the day one does, they become a dice
oracle and a cheat. The production bundle was checked by building it and grepping
for `ForTest`; there were no matches.

## The fast clock is how timers are tested

The 60-second turn clock is not waited out, but no single mechanism covers every
timer path. A test that needs a beat to expire on its own shortens the clock by
setting a fast `Timings` through `__setTimingsForTest`: that is what exercises the
auto-play path ("auto-plays a turn that nobody takes") and the reveal and
round-start beats ("resolves an auto-played reveal into the next round"). Two
other routes cover the rest. `runResultRetry` makes a retry due and fires the
alarm directly with `runDurableObjectAlarm`, which pins the retry that outlives
the empty-table TTL and the retry after an object reload; the retry-until-it-lands
and partial-write cases, like the give-up window once
`__setResultRetryWindowForTest` shortens it, run on the ordinary alarm clock. The
stagnant-wake cap takes its own route: the test injects a wedged auto-play and
waits for the cap to hand the room to the reaper. The consequence for
[known-gaps.md](known-gaps.md) is that the real 60-second interaction between the
alarm and a live socket is never tested end to end.

## Storage is isolated per test file, not per test

From `@cloudflare/vitest-pool-workers` 0.13.0 onward, storage is isolated per test
*file*. `isolatedStorage` no longer exists as an option, and neither does the
rollback-between-tests behavior it implied. A test must not assume that D1 or
Durable Object storage is clean because the previous test in the same file
finished; tables, players and config rows accumulated earlier in the file are
still there.

The project pins `miniflare` through a `package.json` override to the same version
the project's `wrangler` resolves to, so the tests and production run on one
`workerd` vintage. If `wrangler` is bumped, that override should be re-checked: it
is pinned to a wrangler-selected version and will not move on its own. Walking the
test compatibility date back to satisfy an older binary is the tempting fix and the
wrong one, because it would quietly test against different runtime defaults than
production.

## The three harnesses

The Vitest projects cover the engine and the object in isolation. Three scripts
cover the assembled system, and they need a running `wrangler dev` (or a deployed
`MIA_BASE`):

- **`scripts/e2e.ts`** speaks the protocol. It mints real players over HTTP, opens
  real WebSockets, and drives whole games, asserting the redaction boundary, the
  lobby, the error paths, a mid-game reconnect and the D1 result rows. Its
  strategy is seeded by `MIA_SEED`, so the same seed makes the same decisions;
  the dice still come from the server, though, so a failing run does not replay
  exactly. Every iteration takes one action recomputed from the actor's own
  current view — the earlier version precomputed action pairs, and the second
  action in such a pair is stale by construction.
- **`scripts/ui-check.ts`** drives the real client in headless Chromium at a phone
  viewport, plays a full game against bots, captures screenshots and fails on any
  console error.
- **`scripts/bots.ts`** fills the non-human seats so a person can play in a
  browser. It shares `scripts/lib.ts` with `e2e.ts`.

`scripts/lib.ts` carries the client and strategy both harnesses use. Node runs the
`.ts` files directly by stripping types, so imports there carry explicit `.ts`
extensions and nothing in the file may use a Cloudflare-only global.

Two properties of `e2e.ts` are deliberate and should not be "cleaned up":

- The host connects first, sequentially. The earlier version connected everyone
  with `Promise.all` and assumed `clients[0]` was the host, which hid the
  arrival-order bug where the creator could be locked out of starting. The
  dedicated workers test and the two browser contexts in `ui-check` are what cover
  that race now.
- A refusal is always recorded *and* fails anything waiting on the action it
  refused, so a rejected move can never masquerade as a timeout.
