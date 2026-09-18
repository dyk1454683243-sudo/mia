# Mia — lower-level documentation

[README.md](../README.md) is the front door: what Mia is, how to install it, how
to run and deploy it. This directory is the floor below that. It explains how the
system is put together and, more importantly, *why* it is put together that way.

Nothing here is a reference list of the functions in a module — the code is one
keystroke away and a list would go stale the first time someone edited it. Each
page tries to carry something the code cannot: the decision that produced it, the
alternative that was rejected, and the trap that cost someone an afternoon.

## Read this when

- **You are about to change behavior**, not just read it. Start with
  [architecture.md](architecture.md) for the shape of the system, then the page
  for the layer you are touching. The "seams" notes in each page are the
  invariants other layers rely on.
- **You are debugging something that spans layers** — a game that freezes, a
  reconnect that loses a seat, a result that never reaches D1. The
  [table-room.md](table-room.md) alarm diagram and the
  [client.md](client.md) connection diagram are the two places to hold in your
  head at once.
- **You are reasoning about the rules.** [game-engine.md](game-engine.md) has the
  state machine and the reasons the ranking and the doubt resolution are not
  arithmetic.
- **You are deciding whether a known limitation is a bug.** [known-gaps.md](known-gaps.md)
  lists what is deliberately absent and what is still open.

## The pages

| Page | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | The request and WebSocket topology, the four storage roles, why there is one Durable Object per table, and the routing decisions that are easy to undo by accident. |
| [game-engine.md](game-engine.md) | `src/shared/mia.ts`: the hardcoded ranking, the phase machine, legal moves and auto-play, the doubt resolution, final standings, the per-player record behind the endgame stats, and the per-viewer redaction boundary. |
| [table-room.md](table-room.md) | `src/worker/table-room.ts`: hibernation, the single alarm that drives every clock, persistence ordering, table reaping, and the finished-game result write with its retry and give-up behavior. |
| [client.md](client.md) | The browser side: render-over-snapshot, the reconnect lifecycle and its stale-move stamp, the clock-drift correction, why the countdown is updated by hand, the optional sound toggle, and the endgame screen. |
| [identity-and-storage.md](identity-and-storage.md) | The signed cookie, why the signing key lives in a D1 row instead of a secret, the lazily created schema, and what does and does not reach D1. |
| [testing.md](testing.md) | The two test runtimes, the test-only Durable Object subclass that keeps seams out of production, the fast clock, storage isolation, and the three harnesses. |
| [known-gaps.md](known-gaps.md) | Deliberate limitations, unexercised paths, and the one open intermittent bug. |

## Conventions in these pages

- Paths and symbols, never line numbers. Line numbers move; the symbol is the
  stable address.
- Diagrams are [Mermaid](https://mermaid.js.org/) fences, rendered by GitHub.
  There are no image files and no build step.
- Where a decision had a cost, the cost is stated with it. A page that only
  sounds confident is not doing its job.
