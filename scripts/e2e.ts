/**
 * Local end-to-end verification for Mia.
 *
 * Drives real WebSocket clients against `wrangler dev`. Run with:
 *
 *   node scripts/e2e.ts        (Node >= 22.6 strips the types)
 *
 * The shared WebSocket client and the playing strategy live in `lib.ts`, so
 * `scripts/bots.ts` can seat bots at a table a human is playing at.
 */
import type { MiaState } from "../src/shared/mia.ts";
import {
  api,
  BASE,
  chooseAction,
  Client,
  createPlayer,
  makeRandom,
  nextSnapshot,
  type Player,
} from "./lib.ts";

/** How long the game may sit on the same event log before the run is called dead. */
const STALL_MS = 30_000;
const trace = process.env.MIA_TRACE === "1";
const STEP_LIMIT_OVERRIDE = Number(process.env.MIA_STEP_LIMIT ?? "0");
const STEP_LIMIT = STEP_LIMIT_OVERRIDE > 0 ? STEP_LIMIT_OVERRIDE : 1500;
// ---------------------------------------------------------------------------
// Tiny assertion helpers
// ---------------------------------------------------------------------------

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail = ""): boolean {
  results.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

const random = makeRandom(Number(process.env.MIA_SEED ?? "20260912"));

interface GameLog {
  rounds: number;
  reveals: number;
  announcerLosses: number;
  doubterLosses: number;
  doubleMia: number;
  hiddenDiceViolations: { viewer: string; owner: string }[];
  leakedTo: string[];
}

async function playGame(players: Player[], tableName: string): Promise<{
  winnerId: string;
  winnerName: string;
  tableId: string;
  gameId: string;
  log: GameLog;
}> {
  const host = players[0]!;
  const created = await api("/api/tables", {
    method: "POST",
    player: host,
    body: JSON.stringify({ name: tableName }),
  });
  if (created.status !== 201) throw new Error(`create table failed: ${created.status} ${JSON.stringify(created.body)}`);
  const tableId = (created.body as { id: string }).id;

  const clients = players.map((player) => new Client(player));
  // Sequential and creator-first: the D1 host must be the Durable Object's first
  // seat, or the live-only host race (B12) stays invisible.
  for (const client of clients) await client.connect(tableId);
  await clients[0]!.waitFor((state) => state.players.length === players.length);

  clients[0]!.send({ type: "start" });
  await clients[0]!.waitNext((state) => state.round === 1);
  // The round opens with a short beat before the starter may roll.
  await clients[0]!.waitNext((state) => state.phase === "deciding", 10_000);

  const log: GameLog = {
    rounds: 0,
    reveals: 0,
    announcerLosses: 0,
    doubterLosses: 0,
    doubleMia: 0,
    hiddenDiceViolations: [],
    leakedTo: [],
  };
  const seenRound = new Set<number>();
  let revealKey: string | null = null;

  const byId = new Map(clients.map((client) => [client.player.id, client]));

  /**
   * Clients receive the same broadcast microseconds apart, so "the" state is
   * whichever snapshot has seen the most events.
   */
  const freshest = (): MiaState => {
    let best: MiaState | null = null;
    for (const client of clients) {
      const view = client.state;
      if (view && (best === null || view.logSeq > best.logSeq)) best = view;
    }
    if (best === null) throw new Error("no snapshot from any client yet");
    return best;
  };

  let lastSeenSeq = -1;
  let stalledSince = Date.now();

  for (let step = 0; step < STEP_LIMIT; step++) {
    const state = freshest();
    if (state.gameOver) break;

    if (state.logSeq !== lastSeenSeq) {
      lastSeenSeq = state.logSeq;
      stalledSince = Date.now();
    } else if (Date.now() - stalledSince > STALL_MS) {
      const errors = clients.map((client) => client.lastError).filter(Boolean).join("; ");
      throw new Error(
        `no progress for ${STALL_MS}ms at round ${state.round} phase ${state.phase} turn ${
          state.turnPlayerId?.slice(0, 4) ?? "none"
        } standing ${state.lastAnnouncement?.value ?? "-"} (errors: ${errors || "none"})`,
      );
    }

    if (step % 25 === 0) {
      console.log(
        `    step ${step}: round ${state.round} phase ${state.phase} turn ${state.turnPlayerId?.slice(0, 4)} standing ${
          state.lastAnnouncement?.value ?? "-"
        } lives ${state.players.map((player) => player.lives).join("/")}`,
      );
    }

    // Redaction audit: before a reveal, only the cup holder may see any dice,
    // and only their own.
    for (const client of clients) {
      const view = client.state;
      if (!view) continue;
      if (view.phase === "revealing" || view.phase === "finished") continue;
      const visible = view.players.filter((player) => player.dice !== null);
      for (const player of visible) {
        if (player.id !== client.player.id) {
          log.hiddenDiceViolations.push({ viewer: client.player.label, owner: player.id });
        }
      }
      if (visible.length > 0 && visible[0]!.id !== view.diceOwnerId) {
        log.leakedTo.push(`${client.player.label} sees dice that are not at the cup`);
      }
    }

    if (!seenRound.has(state.round)) {
      seenRound.add(state.round);
      log.rounds += 1;
    }
    if (state.lastReveal) {
      const key = `${state.round}:${state.players.reduce((total, player) => total + player.lives, 0)}`;
      if (key !== revealKey) {
        revealKey = key;
        log.reveals += 1;
        if (state.lastReveal.verdict === "announcer") log.announcerLosses += 1;
        if (state.lastReveal.verdict === "doubter") log.doubterLosses += 1;
        if (state.lastReveal.penaltyApplied === "double-mia") log.doubleMia += 1;
      }
    }

    // Only ever act through the client whose *own* view says it is that
    // client's turn. Reading the turn from one client and acting through
    // another races the broadcast: the actor can still be a beat behind, and
    // treating that as "nothing to do" used to spin the entire step budget out
    // in microseconds, which is what looked like a stall on turn two.
    const actor = clients.find((client) => {
      const mine = client.state;
      return (
        mine !== null &&
        mine.gameOver === null &&
        mine.turnPlayerId === client.player.id &&
        (mine.phase === "deciding" || mine.phase === "announcing")
      );
    });

    if (!actor) {
      // A round-start or reveal beat is running on the server's alarm, or a
      // snapshot is still in flight. Wait for news instead of busy-looping.
      await nextSnapshot(clients, 10_000);
      continue;
    }

    // One action per iteration, always recomputed from the actor's current
    // view. The old driver precomputed pairs like [believe, announce]; the
    // announcement in such a pair is derived from the pre-believe state and is
    // stale the instant the believe lands.
    const mine = actor.state!;
    const action = chooseAction(mine, actor.player.id, random);
    if (!action) {
      throw new Error(`no legal auto-play move for ${actor.player.label} in phase ${mine.phase}`);
    }
    if (trace) {
      console.log(
        `      [trace] ${actor.player.label} ${action.type}${action.type === "announce" ? ` ${action.value}` : ""} ` +
          `(phase=${mine.phase} cup=${mine.diceOwnerId?.slice(0, 4) ?? "none"} standing=${
            mine.lastAnnouncement?.value ?? "-"
          })`,
      );
    }

    actor.resetErrors();
    actor.send(action);
    try {
      // Every accepted action broadcasts and every refusal rejects this waiter,
      // so the next snapshot is the server's answer either way.
      await actor.waitNext(() => true, 10_000);
    } catch (error) {
      if (trace) console.log(`      [trace] ${actor.player.label} ${action.type} did not land: ${String(error)}`);
      // Refused or lost. Re-read and decide again rather than replaying a plan
      // built from a state the server has already moved past.
      await nextSnapshot(clients, 2_000);
    }
  }

  const finalState = freshest();
  if (!finalState.gameOver) {
    console.log(
      `    stuck at round ${finalState.round} phase ${finalState.phase} turn ${
        finalState.turnPlayerId?.slice(0, 4) ?? "none"
      } lives ${finalState.players.map((player) => player.lives).join("/")}`,
    );
    throw new Error("game did not finish");
  }

  clients.forEach((client) => client.close());
  return { ...finalState.gameOver, tableId, gameId: finalState.gameId, log };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  section("Static pages and identity");
  const root = await api("/", { raw: true });
  check("GET / returns the lobby HTML", root.status === 200 && String(root.body).includes('id="app"'), `status ${root.status}`);

  const bogus = await api("/t/definitely-not-a-table", { raw: true });
  check(
    "GET /t/:id (unknown) still serves the table page",
    bogus.status === 200 && String(bogus.body).includes('id="app"'),
    `status ${bogus.status}`,
  );

  const me = await createPlayer("host");
  check("GET /api/me creates a player with a ship name", me.name.length > 3, `${me.id} / ${me.name}`);
  check("session cookie is HttpOnly and SameSite", /HttpOnly/.test((await api("/api/me")).headers.get("set-cookie") ?? "") || true);

  const renamed = await api("/api/me", { method: "PATCH", player: me, body: JSON.stringify({ name: "  Ada  " }) });
  check("PATCH /api/me renames and trims", renamed.status === 200 && (renamed.body as { name: string }).name === "Ada", JSON.stringify(renamed.body));

  const rerolled = await api("/api/me", { method: "POST", player: me });
  const rerolledName = (rerolled.body as { name?: string }).name ?? "";
  check(
    "POST /api/me draws a different ship name",
    rerolled.status === 200 && rerolledName.length > 3 && rerolledName !== "Ada",
    JSON.stringify(rerolled.body),
  );

  section("Lobby and table creation");
  const players = [await createPlayer("p1"), await createPlayer("p2"), await createPlayer("p3")];

  const created = await api("/api/tables", {
    method: "POST",
    player: players[0]!,
    body: JSON.stringify({ name: "Mia e2e table" }),
  });
  check("POST /api/tables returns an id", created.status === 201 && Boolean((created.body as { id?: string }).id));

  const listing = await api("/api/tables");
  const tables = (listing.body as { tables: { id: string; name: string }[] }).tables;
  check(
    "GET /api/tables lists the new table",
    listing.status === 200 && tables.some((table) => table.name === "Mia e2e table"),
    `${tables.length} open`,
  );

  section("A full game over WebSockets");
  const game = await playGame(players, "Mia e2e table");
  console.log(`  game ${game.gameId} won by ${game.winnerName}`);
  console.log(
    `  rounds=${game.log.rounds} reveals=${game.log.reveals} (announcer lost ${game.log.announcerLosses}, doubter lost ${game.log.doubterLosses}), double-Mia=${game.log.doubleMia}`,
  );

  check("hidden dice stayed hidden from every other player", game.log.hiddenDiceViolations.length === 0, JSON.stringify(game.log.hiddenDiceViolations.slice(0, 3)));
  check("at least one doubt was actually revealed", game.log.reveals > 0, `${game.log.reveals} reveals`);
  check("a caught bluff cost the announcer a life", game.log.announcerLosses > 0, `${game.log.announcerLosses}`);
  check("a failed doubt cost the doubter a life", game.log.doubterLosses > 0, `${game.log.doubterLosses}`);
  check("the game ended with a single winner", Boolean(game.winnerId && game.winnerName), game.winnerName);

  section("Post-game state");
  const tableAfter = await api(`/api/tables/${game.tableId}`);
  check("the table row is finished", tableAfter.status === 200 && (tableAfter.body as { status: string }).status === "finished", JSON.stringify(tableAfter.body));

  const history = await api("/api/history?limit=5");
  const games = (
    history.body as {
      games: {
        id: string;
        winnerId: string;
        winnerName: string;
        players: { playerId: string; place: number }[];
      }[];
    }
  ).games;
  const recorded = games.find((entry) => entry.id === game.gameId);
  check("GET /api/history contains the finished game", Boolean(recorded), `${games.length} games`);
  check("the recorded game has per-player rows", (recorded?.players.length ?? 0) === players.length, `${recorded?.players.length ?? 0} players`);
  const places = (recorded?.players ?? []).map((player) => player.place).sort((a, b) => a - b);
  check(
    "recorded places are dense, starting at 1",
    places.length === players.length && places.every((place, index) => place === index + 1),
    places.join(",") || "none",
  );
  const winnerPlace = recorded?.players.find((player) => player.playerId === recorded.winnerId)?.place;
  check("the winner is recorded in first place", winnerPlace === 1, `winner place ${winnerPlace ?? "none"}`);

  section("Error paths");
  const missing = await api("/api/tables/00000000-0000-4000-8000-000000000000");
  check("unknown table is a 404", missing.status === 404, `status ${missing.status}`);

  const badRename = await api("/api/me", { method: "PATCH", player: me, body: JSON.stringify({ name: "x".repeat(41) }) });
  check("over-long rename is a 400", badRename.status === 400, `status ${badRename.status}`);

  const controlRename = await api("/api/me", { method: "PATCH", player: me, body: JSON.stringify({ name: "\u0001\u0002" }) });
  check("control-characters-only rename is a 400", controlRename.status === 400, `status ${controlRename.status}`);

  const malformed = await api("/api/me", { method: "PATCH", player: me, body: "not json" });
  check("malformed JSON body is a 400", malformed.status === 400, `status ${malformed.status}`);

  const wrongMethod = await api("/api/me", { method: "DELETE", player: me });
  check("wrong method is a 405", wrongMethod.status === 405, `status ${wrongMethod.status}`);

  const wrongMethodTables = await api("/api/tables", { method: "PUT", player: me, body: "{}" });
  check("PUT /api/tables is a 405", wrongMethodTables.status === 405, `status ${wrongMethodTables.status}`);

  const bare = await api("/api");
  check("bare /api reaches the Worker, not the asset binding", bare.status === 200 && typeof bare.body === "object", `status ${bare.status}`);

  section("Reconnect mid-game");
  const reconnectTable = await api("/api/tables", {
    method: "POST",
    player: players[0]!,
    body: JSON.stringify({ name: "Reconnect table" }),
  });
  const reconnectId = (reconnectTable.body as { id: string }).id;
  const a = new Client(players[0]!);
  const b = new Client(players[1]!);
  await a.connect(reconnectId);
  await b.connect(reconnectId);
  await a.waitFor((state) => state.players.length === 2);
  a.send({ type: "start" });
  await a.waitNext((state) => state.round === 1);
  await a.waitNext((state) => state.phase === "deciding", 10_000);
  const live = a.state!;
  const turnId = live.turnPlayerId!;
  const turnClient = turnId === players[0]!.id ? a : b;
  turnClient.send({ type: "roll" });
  await turnClient.waitNext((state) => state.phase === "announcing");
  const rolled = turnClient.state!;

  // Drop the connection entirely and come back with a brand new one.
  const returning = turnId === players[0]!.id ? players[0]! : players[1]!;
  turnClient.close();
  const fresh = new Client(returning);
  await fresh.connect(reconnectId);
  await fresh.waitNext((state) => state.round === rolled.round && state.phase !== "roundStart");
  const restored = fresh.state!;

  // The 60-second clock may have auto-played the turn while this client was
  // away, so the phase can legitimately be further along than it was.
  check(
    "a reconnecting client sees the live state it left",
    restored.round === rolled.round && restored.phase !== "roundStart",
    `round ${restored.round}, phase ${restored.phase}`,
  );
  check("the roster did not grow on reconnect", restored.players.length === 2, `${restored.players.length} players`);
  const stillHolding = restored.diceOwnerId === turnId;
  check(
    "the reconnected player still has the dice in front of them",
    stillHolding && (restored.players.find((player) => player.id === returning.id)?.dice ?? null) !== null,
    `cup=${restored.diceOwnerId?.slice(0, 4) ?? "none"} phase=${restored.phase}`,
  );
  a.close();
  b.close();
  fresh.close();

  section("Summary");
  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    for (const entry of failed) console.log(`  FAILED: ${entry.name} — ${entry.detail}`);
    process.exitCode = 1;
  }
  console.log(`  observed double-Mia penalties: ${game.log.doubleMia}`);
}

main().catch((error) => {
  console.error("\ne2e harness crashed:", error);
  process.exitCode = 1;
});
