# Mia — dice bluffing for the browser

A phone-first, multiplayer implementation of **Mia**, the German dice bluffing
game. A table takes 2–8 players, no signup: you are given a name and an identity
cookie the first time you load the page. Share a table link, everyone opens it on
their phone, and the last player with lives wins.

Built on Cloudflare Workers, Static Assets, D1 and one Durable Object per table.

```sh
npm install && npm run types
npm run dev                    # then open http://127.0.0.1:8787
```

No Cloudflare account is needed to run or test it locally.

---

## The rules implemented

This is the **plain core ruleset**. The common house variants are deliberately
left out — see below.

- **Lives.** Everyone starts with 6. 2 players minimum, 8 maximum.
- **A roll's value** is the higher die times ten plus the lower die: 6 and 3 is
  `63`, not `9`. A pair is a double (`6·6` is `66`).
- **Ranking, highest to lowest — hardcoded, not computed:**

  ```
  21, 66, 55, 44, 33, 22, 11, 65, 64, 63, 62, 61, 54, 53, 52, 51, 43, 42, 41, 32, 31
  ```

  `21` is **Mia** and beats everything. Doubles beat every mixed roll.
- **A round.** The starter rolls in secret (the "cup") and announces **any**
  value, truth or bluff. Each following player chooses one of:
  - **believe** — take the cup, roll blind, and then announce a value
    **strictly higher** than the one standing (a low roll forces a bluff); or
  - **doubt** — call the previous player a liar and turn their dice over.
- **Resolution of a doubt.** Compare the two by **position in the ranking
  above**, never arithmetically — `66` beats a claimed `65`, and `11` beats a
  claimed `65`:
  - the roll ranks **below** what was announced (bluff caught) → the
    **announcer** loses 1 life;
  - it **equals or outranks** the announcement → the **doubter** loses 1 life;
  - the announcement was Mia **and** the dice really are `21` → the **doubter
    loses 2**.
- **Next round.** Whoever lost the life starts it; if that knocked them out, the
  next living player does.
- **Elimination.** At 0 lives you are out. The last player standing wins.
- **Turn timer.** 60 seconds per decision. On expiry the server plays the safest
  legal move for the idle player — doubt when Mia stands or when nothing higher
  can be announced, otherwise believe and announce the minimum legal value — so
  a dropped phone never stalls the game.

When the game ends it ends as a story: the last round replays as a filmstrip of
every claim, the doubt in red and the truth at the end, with a line of stats per
player, and a **Rematch** button that opens a new table pre-seeded with the same
people and hands the link to every tab still open.

**Variants deliberately left out:** passing or relaying the cup; accepting a
stated Mia without turning the dice over; "rolling your own Mia ends the round".

There is no chat and there are no accounts — identity is just a long-lived
cookie — and a table that has already started tells you so rather than seating
you late.

---

## Architecture

```
browser ──HTTP──► Worker ──► D1          (identity, table directory, finished games)
   │                 │
   │                 └──► TableRoom DO    (one per table: live state, WebSockets)
   └──WebSocket──────────►
```

- **Client** — vanilla TypeScript built by Vite into two pages (`/` lobby and
  `/t/:id` table). No framework; every render is a function of the latest server
  snapshot.
- **Worker** (`src/worker/index.ts`) — serves the static assets, the JSON API,
  the `/t/:id` join link, and proxies WebSocket upgrades into the table's
  Durable Object. There is no SPA fallback on purpose, so an unknown path is a
  real 404 instead of an HTML page.
- **D1** — players, the lobby directory, and **only finished games**: a game's
  result rows are written once at game over. Live game state never touches it.
- **One Durable Object per table** (`TableRoom`) — a turn-based game needs
  exactly-once ordering of who acted when, and a table is an independent,
  naturally serialised unit, so each one gets its own object and needs no
  database round-trip per move. It holds the live state and the table's
  WebSockets, hibernating when nobody is touching it, and drives both the
  60-second turn clock and the reveal/round beats from a **single alarm**.
- **Identity** is a `mia_pid` cookie: the player id plus an HMAC-SHA256
  signature, `HttpOnly`, `SameSite=Lax`, verified in constant time. The signing
  key lives in a D1 `app_config` row, so there is no secret to provision and a
  temporary deploy really is one command.
- **Redaction** happens on the server, per socket: a snapshot is rebuilt for
  each viewer, and your dice are the only ones you can ever be sent before a
  reveal.

This section is the summary. The reasoning behind each choice — what was
rejected and why, the traps that are invisible in the code, and the boundaries
between layers — lives in [docs/](docs/README.md), which is written for anyone
about to change the system.

---

## Requirements

- **Node 23.6 or newer** (developed and verified on 26.8.2). The `scripts/*.ts`
  harnesses are run directly by Node's built-in TypeScript support; Node
  22.6–23.5 can run them with `--experimental-strip-types`.
- **npm 10+** (verified on 11.19.1).
- A Cloudflare account only if you want to deploy. `wrangler` and everything
  else arrive with `npm install`.

## Install

```sh
npm install
npm run types        # generates worker-configuration.d.ts, which tsc needs
```

`worker-configuration.d.ts` is generated and gitignored, so a fresh clone does
not have it and `npm run typecheck` fails without it (TS2688). Re-run
`npm run types` after any change to `wrangler.jsonc`.

npm 11 warns that install scripts for `workerd`, `esbuild`, `sharp` and
`fsevents` are "not yet covered by allowScripts". That is expected and safe to
ignore — the packages still work, and `npm test` runs the real workerd runtime.

To also run the browser check, fetch its Chromium once (it lands in
`.playwright-browsers/`, which is gitignored):

```sh
npm run ui-setup
```

## Run locally

```sh
npm run dev
```

That builds the client, then runs `vite build --watch` and `wrangler dev`
together. Open <http://127.0.0.1:8787>.

Local development needs no Cloudflare account: `wrangler dev` runs the Worker,
D1 and the Durable Object inside workerd, persisting to `.wrangler/`. Create a
table, open its join link in a second browser profile, and play. The assets
binding serves `dist/client`, so `npm run build` must have run at least once —
`npm run dev` does that for you.

## Test and verify

```sh
npm test          # vitest: pure rules engine + clock (node) and the DO + D1 (workerd)
npm run typecheck # tsc --noEmit for the worker and the client projects
```

`npm test` runs two projects: `unit` covers the ranking, legal moves, every
doubt outcome, elimination, placement and the countdown arithmetic in plain
Node; `workers` drives a real `TableRoom` through `@cloudflare/vitest-pool-workers`
with a real D1 and real WebSockets. Storage in the `workers` project is isolated
per test **file**, not per test, so rows written by one test are still there for
the next — see [docs/testing.md](docs/testing.md) before writing a test that
assumes a clean database.

With `npm run dev` running in another terminal, two more harnesses exercise the
running server end to end:

```sh
npm run e2e       # protocol-level: plays a full game over WebSockets and
                  # asserts the lobby, the D1 results and every error path
```

```sh
npm run ui-check  # the real client in headless Chromium at 375x812 (needs
                  # `npm run ui-setup` once); writes screenshots to
                  # .r1-screenshots/ and fails on any console error
```

`ui-check` needs the browser path, which the npm script sets for you. If you
invoke the file directly, set it yourself:

```sh
PLAYWRIGHT_BROWSERS_PATH=$PWD/.playwright-browsers node scripts/ui-check.ts
```

### Playing against bots

The harnesses can play every seat themselves, which leaves nothing for a human
to do. `bots` fills the other seats so you can play in the browser:

```sh
npm run dev                      # terminal 1
npm run bots -- <tableId> 2      # terminal 2, then start the game in the browser
```

Create a table in the browser (or take the id out of its `/t/:id` link), run the
bots, then press **Start the game** in the browser. The bots wait until you do,
play their turns, and stay attached after the final hand so the finished table
keeps its seats. Ctrl-C to leave.

## Deploy

Deploying needs a Cloudflare account. Log in once, then:

```sh
npm run deploy          # npm run build && wrangler deploy
```

To deploy **without an account** — a throwaway worker on a temporary Cloudflare
account:

```sh
npm run deploy:temporary   # npm run build && wrangler deploy --temporary
```

On the temporary account Wrangler provisions the D1 database and the Durable
Object namespace for you, then prints the `workers.dev` URL and a **claim URL**.
The claim URL is a bearer credential: whoever holds it owns the account, and the
account and all its resources are deleted if it is not claimed within 60 minutes.
Treat it like a password — never commit it.

`wrangler.jsonc` intentionally has `database_name` but no `database_id`, so a
fresh account can provision the database itself. If Wrangler writes account
specific IDs back into the file after a deploy, strip them before committing.

To check the bundle without deploying anything:

```sh
npx wrangler deploy --dry-run --outdir dist/worker
```

## Project layout

```
src/shared/     pure TypeScript, no Cloudflare imports
  mia.ts          ranking, legal moves and the whole game state machine
  protocol.ts     WebSocket message + state types shared by both sides
  clock.ts        turn-countdown arithmetic (clock drift captured per snapshot)
  seat-positions.ts  round-table seat geometry (pure, no DOM)
  shake-to-roll.ts   shake / Space roll gesture (pure, no DOM)
  replay.ts       the endgame filmstrip and the per-player stat lines (pure)
  ships.ts        Culture ship-name pool for new players
src/worker/
  index.ts        routes: assets, /t/:id, JSON API, WebSocket upgrade proxy
  table-room.ts   TableRoom Durable Object: live state, sockets, the alarm
  session.ts      signed identity cookie
  db.ts           D1 schema-on-demand and queries
client/
  index.html      lobby page
  table.html      table page (/t/:id serves this)
  src/            lobby.ts, table.ts, net.ts, styles.css
test/
  mia.test.ts     rules engine (node)
  clock.test.ts   countdown arithmetic (node)
  seat-positions.test.ts  round-table rotation (node)
  shake-to-roll.test.ts  shake threshold, Space and the one-roll gate (node)
  replay.test.ts  endgame filmstrip, stat lines and per-player tallies (node)
  room.test.ts    Durable Object + D1 + WebSockets (workerd)
scripts/
  lib.ts          shared harness internals (client, strategy, HTTP)
  e2e.ts          protocol-level end-to-end checks
  bots.ts         seat bots at a table a human is playing at
  ui-check.ts     headless-browser verification and screenshots
docs/             lower-level architecture and rationale (start at docs/README.md)
wrangler.jsonc    Worker, assets, D1 and Durable Object bindings
```

## Sandboxed environments

Where `~/.npm` or Wrangler's global configuration directory is not writable
(agent sandboxes, some CI), point both at paths inside the repo. They are
gitignored:

```sh
npm_config_cache=$PWD/.npm-cache npm install
XDG_CONFIG_HOME=$PWD/.cfstate XDG_CACHE_HOME=$PWD/.cfstate/cache npx wrangler dev
```

Use the same two `XDG_` variables for every `wrangler` invocation — including
`npm run types`, `npm run dev` and `npm run deploy`, which call it for you.
`.cfstate/` will hold account credentials if you deploy with `--temporary`; never
commit it, and never paste its contents anywhere.

## Notes

- Dice come from `crypto.getRandomValues`, ids from `crypto.randomUUID`. There is
  no `Math.random()` in any security or game path.
- The D1 schema is created lazily on first use, because free-tier D1 has no
  migration step.
- This is a low-stakes demo: there is no rate limiting and no abuse protection
  beyond the 8-seat table cap.

## License

[MIT](LICENSE) © 2026 Leslie Hensley
