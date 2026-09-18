# Identity and storage

Three things outlive a game: who you are, the directory of tables, and the record
of games already played. All of them are in D1, and all of them are deliberately
boring.

## Identity is a signed cookie and nothing else

There are no accounts. On the first request that needs one, `ensurePlayer` mints a
random player id and a Culture ship name, inserts a `players` row, signs a cookie
and returns it through `attachSession`. Every later request verifies the cookie and
loads the row.

The cookie value is `<playerId>.<base64url(HMAC-SHA256(playerId, key))>` and the
attributes are `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` 400 days, with
`Secure` added over HTTPS and omitted on localhost so local development works.
Verification uses `crypto.subtle.verify` on the HMAC, which is a constant-time
comparison; an `===` on the signature would be a timing oracle for forging one.

Losing the cookie means losing the player row's identity — you get a new ship name
and a new row. That is acceptable for a low-stakes demo and is the reason there is
no recovery path to build.

### Why the signing key is a D1 row

`resolveSigningKeyMaterial` reads a `session_key` row from `app_config`, and on a
miss generates 32 random bytes and inserts them with `ON CONFLICT DO NOTHING`.
The key is cached per isolate as an imported `CryptoKey` by `getSigningKey`.

The alternative — a Worker secret — is the conventional answer, and it was
rejected for one reason: the project's whole deployment story is
`wrangler deploy --temporary` with no account setup. A secret is a provisioning
step, and a provisioning step breaks "deploy is one command". Putting the key in
D1 means the app creates its own configuration and a temporary account needs
nothing pasted into it. `wrangler.jsonc` carries no account id, no database id and
no secret.

The cost is a cold-start race, and it is worth understanding because the naive
implementation loses identities permanently. Two isolates handling the first
requests against a cold database both read a miss, both generate a key, and if the
write is an upsert the second overwrites the first. Every cookie already signed
with the losing key then fails verification forever, and those players silently
lose their name with no way back. The fix is write-once plus re-read: insert with
`DO NOTHING`, then read whichever value actually landed and use that. The function
is exported specifically so the race test can call it directly, since
`getSigningKey`'s per-isolate cache would hide the race behind a shared promise.

## The D1 schema is created lazily

Free-tier D1 has no migration step, so `ensureSchema` runs `CREATE TABLE IF NOT
EXISTS` statements in one batch on first use. The promise is cached per isolate to
avoid running the batch on every request, and — this is the part that matters —
**the cache is cleared on failure**. Caching a rejected promise would poison the
isolate for its entire lifetime: one transient error and every request it serves
afterwards fails at the schema step.

The tables are:

| Table | Holds |
| --- | --- |
| `app_config` | the session signing key |
| `players` | identity: id, name, timestamps |
| `tables` | the lobby directory: name, creator, status, seat counts |
| `table_seats` | the roster a rematch hands to a brand-new table, until its game starts |
| `games` | one row per finished game: table, times, winner |
| `game_players` | per-player result: place, lives left, rounds played |

`tables.status` is one of `waiting`, `playing`, `finished`, `abandoned`. The
`max_players` column exists but `createTable` binds the real `MAX_PLAYERS`
constant; the schema default of 8 is a floor for hand-written rows, not a second
source of truth.

## Only finished games reach D1

This is the storage decision the architecture rests on. While a game is running,
nothing about it is in D1 — no moves, no state, no partial results. The only write
path is `recordGame`, called once when the Durable Object sees `gameOver`.

`recordGame` inserts the game and all its `game_players` rows in a single
`env.DB.batch`, so a half-written result is impossible, and both inserts are
`ON CONFLICT DO NOTHING`, so a retry after a partial failure is safe. Places come
from the engine's `finalStandings`, not from seat order in the roster.

The Durable Object never reads the schema module for game state; only for the
result write, the `tables` row it keeps in step, and the seats a rematch hands to
a brand-new table. That is why D1 is not on
the hot path for a move and why the game survives a D1 outage up to the moment it
ends. Once it ends, the result retry logic in
[table-room.md](table-room.md) takes over.

## The lobby directory

The `tables` row is created by the Worker when a table is created, and updated by
the Durable Object as players join, leave, start and finish. It is a cache of what
is happening, not a source of truth: the roster and the status that matter for
playing are in the object. The one roster that does reach D1 is the pre-game
handoff a rematch makes, below.

`listOpenTables` shows rows whose status is `waiting` or `playing` and whose
`updated_at` is within the last 30 minutes, waiting tables first. The staleness
filter is a backstop. The primary mechanism is that a reaped table is marked
`abandoned` before its storage is dropped, so the lobby stops listing a table that
no longer exists. A finished table is deliberately left `finished`, because the
result write has just set that status and relabelling it would clobber the record.

The creator is stored as `host_id` and is authoritative for who may start the
game. The Worker reads it on each upgrade and forwards it; the Durable Object
compares against it. Nothing derives the host from connection order. See
[table-room.md](table-room.md).

`listPlayerNames` backs the new-player name pick with `ORDER BY created_at DESC
LIMIT 500` and an index on `created_at`. It runs on every first visit purely to
avoid handing out a duplicate ship name, so an unbounded scan of every player ever
would grow without limit for a cosmetic benefit. Once the recent pool is
exhausted, `pickShipName` falls back to reusing a name.

## The rematch handoff is directory data, not game state

`table_seats` is the one place a table's roster reaches D1, and it exists only for
the gap a rematch opens. The new table's directory row has to exist before anyone
can open its link, but its Durable Object does not exist until the first socket
arrives, and a room with no state has nowhere to keep a roster.

So the finished room writes the seats in the same batch as the new `tables` row,
and the new room reads them once, on its first connect, to build its lobby. They
are deleted when that table's game starts. The room applies the seat cap to what
it reads: the rows are a roster of who was promised a place, not a licence for a
ninth arriver — a player who is not in the seeded list is refused with
`table-full` once the roster is at `MAX_PLAYERS`. Only `handleRematch` writes
these rows, and it copies a game's roster, which is at most `MAX_PLAYERS`; a
larger set can only be hand-written, and a lobby built from one refuses to start
rather than becoming an out-of-spec game. What is stored is who is expected — the
same fact the directory's `player_count` already carries — not lives, dice, moves
or anything that happened in the finished game, and nothing updates the rows while
a game is running. `recordGame` remains the only write that carries a game's
result, and the rematch adds no column to it.

The cost is the same one the directory already pays: a rematch link nobody ever
opens leaves its `table_seats` rows behind, because there is no Durable Object to
reap — the row for a table created through the lobby is not deleted either, it is
only hidden from the listing once it goes stale. Nothing reads those rows, and
the alternative (a cleanup pass that deletes a row somebody might still open) is a
worse trade for a demo than a few dead rows in a free-tier database.

The alternative was to hand the roster from one Durable Object straight to the
next with its own internal request. That would have added a second party whose
instructions the object accepts, and "the Worker is the only party that can set
the headers a `TableRoom` trusts" is an invariant worth more than one small table.
The press itself is in [table-room.md](table-room.md).

## What reaches the browser

The JSON API is small and read-mostly: `/api/me` (with `PATCH` to rename),
`/api/tables`, `/api/tables/:id`, `/api/tables/:id/ws`, `/api/history`. Names and
table names are trimmed, control characters stripped and length-checked in
`validateName`; over-long or malformed input is a 400, a wrong method is a 405.
The history endpoint clamps its `limit` query parameter. There is no endpoint that
exposes another player's hidden dice, because dice live only in the Durable Object
and leave it only through redaction.
