# Testing

The suite runs in two different runtimes, and the split is the point.

`vitest.config.ts` defines two projects:

- **`unit`** runs in plain Node with no Workers runtime. It covers the pure rules
  engine, the clock arithmetic, the seat-limit constants, the round table's
  seat geometry, the showdown's verdict and beat arithmetic, the endgame
  replay's filmstrip and stat lines, and the personal mood catalog (allow-list,
  fallback, body-class names, and that both HTML pages apply the stored mood
  before the stylesheet). These are the tests that can be reasoned
  about from the code alone, and they run fast because there is no platform
  underneath them.
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
  console error. It fills the table to `MAX_PLAYERS` by default, because the
  announce ladder's geometry is tightest at a full table and a three-seat run
  passes while an eight-seat one fails; `MIA_UI_SEATS` runs a smaller table.
  **Run both.** The worst case is not one seat count: the ring widens below seven
  seats (`seatPositions` uses `ry = 0.8` rather than `0.76`), which puts the
  viewer's chair at 90% of the felt instead of 88% and makes *three* seats the
  tightest case for the seat-versus-controls overlap — the opposite of the
  ladder. A change that passes at eight can fail at three, and did. The viewer's
  dice obey the same "run both" rule for their own reason: `ui-check` forces the
  longest pool name onto the viewer's seat and measures the dice against the felt
  card, which leaves the least room below the chair at three seats (90%) even
  though the ring itself is tightest at eight.
  Its showdown-suspense check mounts an off-screen clone of the live showdown
  with `--showdown-elapsed` scrubbed, so it can read the first and last beat for
  all three verdict tones rather than only whichever tone the random dice
  produced. The countdown-ring check is the sibling of that idea: it freezes the
  bots on the viewer's own turn and reads a live frame above ten seconds, a live
  frame below, and the round-start beat — the real clock, not a class poked in —
  so the assertion fails if the red arrived at sixty seconds, or arrived at the
  2s top of a round where nobody is running out of time, and it reads a
  forced-urgent clone under both motion preferences so the reduced-motion skip
  cannot pass by accident. The mood check is the sibling of the rename-persist
  idea: it uses the real picker, asserts Stammtisch, Night Shift and Press are
  different `--felt` values, watches the class land on `<html>` at
  `domcontentloaded` (the first-paint script, not the page module), and checks
  the lobby and waiting-room boxes do not move for the token-only moods. Press
  is the light theme: the same pass also asserts zero radius on the chrome,
  no card shadow, and WCAG AA contrast on the ink, and takes phone plus
  desktop screenshots. Extra mood screenshots are taken from the same DOM — a
  class toggle, not a second game — so a mood that still needs a component
  change is visible in the picture.
  At the end it checks the finished screen's filmstrip,
  stats and rematch against the snapshot, and opens the rematch link in a second
  page to see the seeded lobby — the one place the rematch handoff is exercised
  with a real browser and a real cookie.
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

## An assertion that cannot fail is not coverage

A test earns its place by failing when the thing it protects breaks. There are four
ways it can quietly not do that, and every one of them has shipped here.

**The assertion is unreachable given the fixture.** A `COUNT(*)` against a sentinel
row is trivially zero in a file that never finishes a game, so it holds whether or
not the code is correct. When a fix makes the bad state unreachable by
construction, that unreachability *is* the result — there is nothing left for an
assertion to catch, and the honest move is to delete it and narrow the test's name
to what it does pin.

**The fixture never reaches the regime where the property breaks.** A check can be
exactly right and still never run where it would fail. Prefer a default that
exercises the worst case over an opt-in someone has to remember: `ui-check` fills
to `MAX_PLAYERS` rather than leaving the full table behind a flag, so the tightest
layout is on the default path.

**The sampling is scoped to the state the feature was designed for.** A threshold
usually has more than one way to be crossed, and a probe watches the one the
feature was written for. The #49 countdown reddens the felt in the turn clock's
last ten seconds, and it was checked exactly there — one live frame above ten
seconds, one below — with the sampling gated on `phase === "deciding" || phase ===
"announcing"`. But `urgent` was `seconds <= COUNTDOWN_URGENT_SECONDS` against
*any* `deadlineAt`, and `armRoundStart` (2s) and the reveal (5s) arm one the same
way the 60s turn does, so every frame of those phases sat inside ten seconds: the
felt and the whole page went red for the beat at the top of every round, before
the clock had even started, and green again once it had. Nothing here was vacuous
— the checks were sound, each mutation reproduced, the suite was green — the
coverage simply stopped at the state the treatment was meant for, and the bug was
plain in the round-start screenshot, a frame nobody had looked at. So enumerate
the states that can cross a threshold, sample the ones you did not design for,
and put the scope where the threshold lives: `urgent` now requires the phase
*window* to outlast the threshold, in `src/shared/clock.ts` beside the constant,
rather than in a CSS selector. The tell that a new case is a real gap and not a
restatement of the ones beside it: with the fix reverted it should be the *only*
red check, as the round-start assertion was while the above-ten and below-ten
pair stayed green.

**The assertion is about existence when the property is about timing.** A check
that claimed, actual and the stamp all appear says nothing about *when* each one
does, and for anything staged over time the timing is the whole feature. The #29
showdown shipped striking the claimed value through in red from its first frame
— the verdict given away 2750ms before the stamp landed — with every assertion
green, because each one only asked whether an element was there. The fix was to
assert the frame: mount an off-screen clone with `--showdown-elapsed` scrubbed to
a chosen fraction and read the computed style at that instant. That also makes
the check independent of which verdict the dice happen to produce, so all three
tones are covered on every run instead of whichever one turned up.

Tests are weak here in a way that is worth naming: they are good at *what* exists
and poor at *when* it appears and *what it looks like*. [AGENTS.md](../AGENTS.md)
asks a visual PR to say what its screenshot shows at the moment that matters,
because reading the picture is the step that catches this class.

The round table's rotation is the case where the fixture cannot reach the regime
at all. The browser harness creates the table through the UI and the bots join
after it, so the viewer is always `players[0]`; with `viewerIndex === 0`,
`(index - viewerIndex)` is identically `index` and the centring term is dead code
in every run. The harness's seat assertion still earns its place — it tells a ring
from a list — but the rotation itself is pinned in `test/seat-positions.test.ts`,
which imports the geometry under Node and walks every seat count and viewer index.
That is only possible because `seatPositions` lives in its own DOM-free module
(`src/shared/seat-positions.ts`); `client/src/table.ts` cannot be imported under
Node, because it queries `#app` at module scope.

Before trusting a new test, break the thing it guards and watch it go red —
changing one thing at a time, so you learn which assertion is load-bearing rather
than only which one is listed first. [AGENTS.md](../AGENTS.md) requires that observed
failure to be recorded in the PR body.
