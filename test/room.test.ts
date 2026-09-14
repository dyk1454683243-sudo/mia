/**
 * TableRoom integration tests: real Durable Object, real D1, real WebSockets,
 * driven inside workerd by @cloudflare/vitest-pool-workers.
 */
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Die, MiaState } from "../src/shared/mia";
import type { ServerMessage, StateView } from "../src/shared/protocol";
import { ensureSchema } from "../src/worker/db";
import { signCookie } from "../src/worker/session";
import { clampAlarmTime, resultWriteBackoffMs } from "../src/worker/table-room";
import { TestTableRoom } from "./table-room-test";

/** Fast clock for tests: a turn expires in a second. */
const FAST = { turnMs: 1_000, revealMs: 400, roundStartMs: 150 };
/**
 * Human-paced clock: a real turn length so the server never auto-plays while a
 * test is driving seats by hand, with a quick reveal beat. The round-start beat
 * matches the engine default so it cannot expire mid-drive.
 */
const DRIVE = { turnMs: 60_000, revealMs: 200, roundStartMs: 2_000 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mint a signed session cookie plus a matching players row. */
async function makePlayer(name: string): Promise<{ id: string; name: string; cookie: string }> {
  const id = crypto.randomUUID();
  await ensureSchema(env);
  await env.DB.prepare(`INSERT INTO players (id, name, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?3)`)
    .bind(id, name, Date.now())
    .run();
  return { id, name, cookie: `mia_pid=${await signCookie(env, id)}` };
}

async function createTableRow(name: string, hostId: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await ensureSchema(env);
  await env.DB.prepare(
    `INSERT INTO tables (id, name, host_id, status, player_count, max_players, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'waiting', 0, 8, ?4, ?4)`,
  )
    .bind(id, name, hostId, now)
    .run();
  return id;
}

interface TestSocket {
  ws: WebSocket;
  states: StateView[];
  errors: string[];
  nextState(predicate?: (view: StateView) => boolean, timeoutMs?: number): Promise<StateView>;
  send(message: unknown): void;
  close(): void;
}

async function connect(tableId: string, player: { name: string; cookie: string }): Promise<TestSocket> {
  const response = await SELF.fetch(`https://mia.test/api/tables/${tableId}/ws`, {
    headers: {
      Upgrade: "websocket",
      Cookie: player.cookie,
      "X-Mia-Table-Name": encodeURIComponent("Test table"),
      "X-Mia-Table-Id": tableId,
    },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (!ws) throw new Error("no webSocket on the 101 response");
  ws.accept();

  const states: StateView[] = [];
  const errors: string[] = [];
  const waiters: { predicate: (view: StateView) => boolean; resolve: (view: StateView) => void }[] = [];

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as ServerMessage;
    if (message.type === "error") {
      errors.push(message.message);
      return;
    }
    states.push(message);
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index]!;
      if (waiter.predicate(message)) {
        waiters.splice(index, 1);
        waiter.resolve(message);
      }
    }
  });

  return {
    ws,
    states,
    errors,
    nextState(predicate = () => true, timeoutMs = 5_000) {
      const existing = states.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<StateView>((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(
            new Error(`timed out waiting for a snapshot (${states.length} seen, errors: ${errors.join("; ") || "none"})`),
          );
        }, timeoutMs);
      });
    },
    send(message: unknown) {
      ws.send(JSON.stringify(message));
    },
    close() {
      try {
        ws.close(1000, "test done");
      } catch {
        /* already closed */
      }
    },
  };
}

function stubFor(tableId: string) {
  return env.TABLE.getByName(tableId);
}

/**
 * `runInDurableObject` types its callback from the stub's branding, which the
 * base class does not propagate, so the instance is narrowed back to the test
 * subclass here — the runtime value genuinely is a `TestTableRoom`, because
 * `worker-entry.ts` binds that class as `TABLE`.
 */
async function inRoom<T>(tableId: string, fn: (room: TestTableRoom) => T | Promise<T>): Promise<T> {
  return await runInDurableObject(stubFor(tableId), async (instance) => fn(instance as TestTableRoom));
}

async function readState(tableId: string): Promise<MiaState | null> {
  return await inRoom(tableId, (room) => room.__stateForTest());
}

async function forceDice(tableId: string, playerId: string, dice: [Die, Die]): Promise<void> {
  await inRoom(tableId, (room) => room.__setDiceForTest(playerId, dice));
}

async function setTimings(tableId: string, timings: typeof FAST): Promise<void> {
  await inRoom(tableId, (room) => room.__setTimingsForTest(timings));
}

async function setLives(tableId: string, playerId: string, lives: number): Promise<void> {
  await inRoom(tableId, async (room) => {
    const state = await room.__stateForTest();
    if (!state) throw new Error("no state");
    const player = state.players.find((candidate) => candidate.id === playerId);
    if (!player) throw new Error("unknown player");
    player.lives = lives;
    // Committing through the seam persists the change without rolling new dice.
    await room.__setDiceForTest(playerId, player.dice ?? [1, 1]);
  });
}

/** Shorten the empty-table TTL so reaping can be watched in real time. */
async function setEmptyTtl(tableId: string, ms: number): Promise<void> {
  await inRoom(tableId, (room) => {
    (room as unknown as { emptyTtlMs: number }).emptyTtlMs = ms;
  });
}

/** Wait until it is `playerId`'s turn to decide. */
async function waitForTurn(tableId: string, playerId: string, timeoutMs = 15_000): Promise<void> {
  await waitFor(async () => {
    const state = await readState(tableId);
    return state?.phase === "deciding" && state.turnPlayerId === playerId;
  }, timeoutMs);
}

/**
 * Drive one round by hand: the starter rolls `dice`, announces `value`, and the
 * doubter calls it. Whether the starter loses (a caught bluff) or the doubter
 * loses (an honest claim) is left to the dice.
 */
async function driveRound(
  tableId: string,
  starterSocket: TestSocket,
  doubterSocket: TestSocket,
  starterId: string,
  dice: [Die, Die],
  value: number,
): Promise<void> {
  starterSocket.send({ type: "roll" });
  await waitFor(async () => (await readState(tableId))?.phase === "announcing", 5_000);
  await forceDice(tableId, starterId, dice);
  starterSocket.send({ type: "announce", value });
  await waitFor(async () => (await readState(tableId))?.lastAnnouncement?.value === value, 5_000);
  doubterSocket.send({ type: "doubt" });
}

/**
 * Play a two-player table to game over with a single caught bluff, and return
 * the game id. `sockets[0]` must be the host (the first seat).
 */
async function finishTwoPlayerGame(
  tableId: string,
  hostId: string,
  sockets: TestSocket[],
): Promise<string> {
  sockets[0]!.send({ type: "start" });
  const started = await sockets[0]!.nextState((view) => view.state.round === 1, 5_000);
  const starterId = started.state.turnPlayerId!;
  const starterIndex = starterId === hostId ? 0 : 1;
  await setLives(tableId, starterId, 1);
  await waitFor(async () => (await readState(tableId))?.phase === "deciding", 5_000);
  await driveRound(tableId, sockets[starterIndex]!, sockets[1 - starterIndex]!, starterId, [3, 1], 65);
  const finished = await sockets[starterIndex]!.nextState((view) => view.state.gameOver !== null, 6_000);
  return finished.state.gameId;
}

/** Arm the next `times` result writes to fail, as a flaky D1 would. */
async function armResultWriteFailures(tableId: string, times: number): Promise<void> {
  await inRoom(tableId, (room) => room.__failResultWritesForTest(times));
}

interface ResultWriteInternals {
  attempts: number;
  retryAt: number | null;
  written: boolean;
}

/** Read the result-write bookkeeping the tests assert on. */
async function resultWriteInternals(tableId: string): Promise<ResultWriteInternals> {
  return await inRoom(tableId, async (room) => {
    const internals = room as unknown as { resultsRetryAt: number | null; resultsWritten: boolean };
    return {
      attempts: await room.__resultWriteAttemptsForTest(),
      retryAt: internals.resultsRetryAt,
      written: internals.resultsWritten,
    };
  });
}

/** Make the pending result retry due now and run the alarm out of band. */
async function runResultRetry(tableId: string): Promise<boolean> {
  await inRoom(tableId, (room) => {
    (room as unknown as { resultsRetryAt: number | null }).resultsRetryAt = null;
  });
  return await runDurableObjectAlarm(stubFor(tableId));
}

async function tableStatus(tableId: string): Promise<string | undefined> {
  const row = await env.DB.prepare(`SELECT status FROM tables WHERE id = ?1`)
    .bind(tableId)
    .first<{ status: string }>();
  return row?.status;
}

async function playerCount(tableId: string): Promise<number | undefined> {
  const row = await env.DB.prepare(`SELECT player_count FROM tables WHERE id = ?1`)
    .bind(tableId)
    .first<{ player_count: number }>();
  return row?.player_count;
}

async function countResultRows(gameId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM game_players WHERE game_id = ?1`)
    .bind(gameId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function socketCount(tableId: string): Promise<number> {
  return await runInDurableObject(stubFor(tableId), (_instance, state) => state.getWebSockets().length);
}

async function storedRoom(tableId: string): Promise<MiaState | null> {
  return await runInDurableObject(
    stubFor(tableId),
    async (_instance, state) => (await state.storage.get<MiaState>("room")) ?? null,
  );
}

async function scheduledAlarm(tableId: string): Promise<number | null> {
  return await runInDurableObject(stubFor(tableId), (_instance, state) => state.storage.getAlarm());
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForValue<T>(check: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value !== null) return value;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for value");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TableRoom", () => {
  beforeAll(async () => {
    await ensureSchema(env);
  });

  it("lists a joined table in the D1 lobby directory", async () => {
    const host = await makePlayer("Host");
    const tableId = await createTableRow("Host's table", host.id);
    const socket = await connect(tableId, host);

    const view = await socket.nextState();
    expect(view.you).toBe(host.id);
    expect(view.state.round).toBe(0);
    expect(view.state.players.map((player) => player.name)).toEqual(["Host"]);
    expect(view.connected).toEqual([host.id]);

    // The D1 directory row is updated just after the broadcast, so give it a beat.
    await waitFor(async () => {
      const row = await env.DB.prepare(`SELECT player_count FROM tables WHERE id = ?1`)
        .bind(tableId)
        .first<{ player_count: number }>();
      return row?.player_count === 1;
    });
    const row = await env.DB.prepare(`SELECT player_count, status FROM tables WHERE id = ?1`)
      .bind(tableId)
      .first<{ player_count: number; status: string }>();
    expect(row?.player_count).toBe(1);
    expect(row?.status).toBe("waiting");

    socket.close();
  });

  it("keeps a player's dice private until a doubt reveals them", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const tableId = await createTableRow("Hidden dice", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);

    await annaSocket.nextState((view) => view.state.players.length === 2);
    annaSocket.send({ type: "start" });
    const started = await annaSocket.nextState((view) => view.state.round === 1);
    const starterId = started.state.turnPlayerId!;
    const starterSocket = starterId === anna.id ? annaSocket : boSocket;
    const otherSocket = starterId === anna.id ? boSocket : annaSocket;

    await waitFor(async () => (await readState(tableId))?.phase === "deciding");
    starterSocket.send({ type: "roll" });

    // The roller sees their own dice.
    const withDice = await starterSocket.nextState(
      (view) => (view.state.players.find((player) => player.id === starterId)?.dice ?? null) !== null,
    );
    expect(withDice.state.players.find((player) => player.id === starterId)!.dice).not.toBeNull();

    // The other player sees no dice at all, but does know who holds the cup.
    const otherView = await otherSocket.nextState((view) => view.state.diceOwnerId === starterId);
    expect(otherView.state.players.every((player) => player.dice === null)).toBe(true);

    // Force a losing hand, claim something better, and let the other player doubt.
    await forceDice(tableId, starterId, [3, 1]);
    starterSocket.send({ type: "announce", value: 65 });
    await starterSocket.nextState((view) => view.state.lastAnnouncement?.value === 65);
    otherSocket.send({ type: "doubt" });

    const revealed = await otherSocket.nextState(
      (view) => view.state.phase === "revealing" || view.state.lastReveal !== null,
    );
    expect(revealed.state.players.find((player) => player.id === starterId)!.dice).toEqual([3, 1]);
    expect(revealed.state.pendingDoubt?.actual).toBe(31);

    annaSocket.close();
    boSocket.close();
  });

  it("never turns a stray pair of dice face up at the reveal", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const cara = await makePlayer("Cara");
    const tableId = await createTableRow("Stray dice", anna.id);
    const sockets = [await connect(tableId, anna), await connect(tableId, bo), await connect(tableId, cara)];
    await sockets[0]!.nextState((view) => view.state.players.length === 3);

    sockets[0]!.send({ type: "start" });
    const started = await sockets[0]!.nextState((view) => view.state.round === 1);
    const order = started.state.players.map((player) => player.id);
    const starterId = started.state.turnPlayerId!;
    const starterIndex = order.indexOf(starterId);
    const starter = sockets[starterIndex]!;
    const doubter = sockets[(starterIndex + 1) % 3]!;
    const neutralId = order[(starterIndex + 2) % 3]!;

    await waitFor(async () => (await readState(tableId))?.phase === "deciding");
    starter.send({ type: "roll" });
    await starter.nextState((view) => view.state.phase === "announcing");
    await forceDice(tableId, starterId, [3, 1]);
    starter.send({ type: "announce", value: 65 });
    await starter.nextState((view) => view.state.lastAnnouncement?.value === 65);

    // Plant a second pair on a player who is neither at the cup nor about to be
    // doubted. The old phase-based redaction returned every pair once a reveal
    // began, so this is exactly the leak the shared boundary must prevent.
    await inRoom(tableId, async (room) => {
      const state = await room.__stateForTest();
      const player = state?.players.find((candidate) => candidate.id === neutralId);
      if (!state || !player) throw new Error("no state");
      player.dice = [6, 6];
    });
    expect((await readState(tableId))?.players.find((player) => player.id === neutralId)?.dice).toEqual([6, 6]);

    doubter.send({ type: "doubt" });
    await doubter.nextState((view) => view.state.phase === "revealing" || view.state.lastReveal !== null);

    for (const socket of sockets) {
      const view = await socket.nextState((state) => state.state.phase === "revealing" || state.state.lastReveal !== null);
      // The doubted player's dice are public...
      expect(view.state.players.find((player) => player.id === starterId)?.dice).toEqual([3, 1]);
      // ...and the planted pair is not, to anybody.
      expect(view.state.players.find((player) => player.id === neutralId)?.dice).toBeNull();
    }

    for (const socket of sockets) socket.close();
  });

  it("rejects illegal actions server-side", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const tableId = await createTableRow("Illegal moves", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    await annaSocket.nextState((view) => view.state.players.length === 2);

    // Starting is the creator's call, and the refusal names them.
    boSocket.send({ type: "start" });
    await waitFor(() => boSocket.errors.length > 0);
    expect(boSocket.errors.join(" ")).toContain("Only Anna");

    annaSocket.send({ type: "start" });
    const started = await annaSocket.nextState((view) => view.state.round === 1);

    // Not your turn.
    const notTurn = started.state.turnPlayerId === anna.id ? boSocket : annaSocket;
    const before = notTurn.errors.length;
    notTurn.send({ type: "roll" });
    await waitFor(() => notTurn.errors.length > before);
    expect(notTurn.errors[notTurn.errors.length - 1]).toContain("not your turn");

    // Roll, then try a value that is not a roll at all, then one that is not higher.
    const turnSocket = started.state.turnPlayerId === anna.id ? annaSocket : boSocket;
    const otherSocket = turnSocket === annaSocket ? boSocket : annaSocket;
    await waitFor(async () => (await readState(tableId))?.phase === "deciding");
    turnSocket.send({ type: "roll" });
    await turnSocket.nextState((view) => view.state.phase === "announcing");

    turnSocket.send({ type: "announce", value: 99 });
    await waitFor(() => turnSocket.errors.some((error) => error.includes("not a legal roll")));

    turnSocket.send({ type: "announce", value: 31 });
    await turnSocket.nextState((view) => view.state.lastAnnouncement?.value === 31);

    otherSocket.send({ type: "believe" });
    await otherSocket.nextState((view) => view.state.phase === "announcing");
    otherSocket.send({ type: "announce", value: 31 });
    await waitFor(() => otherSocket.errors.some((error) => error.includes("not higher")));

    annaSocket.close();
    boSocket.close();
  });

  it("refuses a move replayed from a previous round", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const tableId = await createTableRow("Stale moves", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    await annaSocket.nextState((view) => view.state.players.length === 2);

    annaSocket.send({ type: "start" });
    const started = await annaSocket.nextState((view) => view.state.round === 1);
    const starterId = started.state.turnPlayerId!;
    const starter = starterId === anna.id ? annaSocket : boSocket;
    const doubter = starterId === anna.id ? boSocket : annaSocket;

    // Round 1: the opener bluffs, the next player doubts, and the reveal beat
    // seeds round 2.
    await waitFor(async () => (await readState(tableId))?.phase === "deciding");
    starter.send({ type: "roll" });
    await starter.nextState((view) => view.state.phase === "announcing");
    await forceDice(tableId, starterId, [3, 1]);
    starter.send({ type: "announce", value: 65 });
    await starter.nextState((view) => view.state.lastAnnouncement?.value === 65);
    const round1Seq = (await readState(tableId))!.logSeq;

    doubter.send({ type: "doubt" });
    await doubter.nextState((view) => view.state.phase === "revealing" || view.state.lastReveal !== null);
    await waitFor(async () => {
      const state = await readState(tableId);
      return state !== null && state.round === 2 && state.phase === "deciding";
    }, 15_000);

    // A queued round-1 move, replayed once round 2 is under way, is refused and
    // changes nothing.
    const round2 = (await readState(tableId))!;
    const turn = round2.turnPlayerId === anna.id ? annaSocket : boSocket;
    const errorsBefore = turn.errors.length;
    turn.send({ type: "roll", logSeq: round1Seq });
    await waitFor(() => turn.errors.length > errorsBefore);
    expect(turn.errors[turn.errors.length - 1]).toContain("stale");
    expect((await readState(tableId))?.logSeq).toBe(round2.logSeq);
    expect((await readState(tableId))?.phase).toBe("deciding");

    // The same move against the current snapshot lands.
    turn.send({ type: "roll", logSeq: round2.logSeq });
    await turn.nextState((view) => view.state.phase === "announcing");

    annaSocket.close();
    boSocket.close();
  }, 30_000);

  it("answers a ping to the caller only, so it cannot amplify", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const tableId = await createTableRow("Ping", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    await annaSocket.nextState((view) => view.state.players.length === 2);
    await boSocket.nextState((view) => view.state.players.length === 2);

    const annaBefore = annaSocket.states.length;
    const boBefore = boSocket.states.length;
    annaSocket.send({ type: "ping" });
    await waitFor(() => annaSocket.states.length > annaBefore);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // One client's ping used to broadcast a freshly redacted snapshot to every
    // socket at the table.
    expect(boSocket.states.length).toBe(boBefore);

    annaSocket.close();
    boSocket.close();
  });

  it("plays a game to a win and writes the result rows to D1", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const tableId = await createTableRow("Decider", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    await annaSocket.nextState((view) => view.state.players.length === 2);

    annaSocket.send({ type: "start" });
    const started = await annaSocket.nextState((view) => view.state.round === 1);
    const starterId = started.state.turnPlayerId!;
    const openerSocket = starterId === anna.id ? annaSocket : boSocket;
    const otherSocket = starterId === anna.id ? boSocket : annaSocket;
    const otherId = starterId === anna.id ? bo.id : anna.id;
    const otherName = starterId === anna.id ? bo.name : anna.name;

    // One life left, and a hand that cannot back up a claim of 65.
    await setLives(tableId, starterId, 1);
    await waitFor(async () => (await readState(tableId))?.phase === "deciding");
    openerSocket.send({ type: "roll" });
    await openerSocket.nextState((view) => view.state.phase === "announcing");
    await forceDice(tableId, starterId, [3, 1]);
    openerSocket.send({ type: "announce", value: 65 });
    await openerSocket.nextState((view) => view.state.lastAnnouncement?.value === 65);

    // The doubt lands: 31 does not outrank a claimed 65, so the opener loses the
    // life and, with only one left, the game.
    otherSocket.send({ type: "doubt" });
    const finished = await openerSocket.nextState((view) => view.state.gameOver !== null, 6_000);
    expect(finished.state.phase).toBe("finished");
    expect(finished.state.gameOver?.winnerId).toBe(otherId);
    expect(finished.state.gameOver?.winnerName).toBe(otherName);
    expect(finished.state.players.find((player) => player.id === starterId)!.dice).toEqual([3, 1]);
    expect(finished.state.players.find((player) => player.id === starterId)!.eliminated).toBe(true);

    const gameId = finished.state.gameId;
    const game = await waitForValue(async () => {
      const row = await env.DB.prepare(`SELECT * FROM games WHERE id = ?1`).bind(gameId).first<{
        id: string;
        table_id: string;
        table_name: string;
        winner_id: string;
        winner_name: string;
        started_at: number;
        finished_at: number;
      }>();
      return row ?? null;
    });
    expect(game.winner_id).toBe(otherId);
    expect(game.winner_name).toBe(otherName);
    expect(game.table_id).toBe(tableId);
    expect(game.finished_at).toBeGreaterThanOrEqual(game.started_at);

    const rows = await env.DB.prepare(
      `SELECT player_id, name, place, lives_left FROM game_players WHERE game_id = ?1 ORDER BY place ASC`,
    )
      .bind(gameId)
      .all<{ player_id: string; name: string; place: number; lives_left: number }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results?.[0]?.player_id).toBe(otherId);
    expect(rows.results?.[0]?.place).toBe(1);
    expect(rows.results?.[0]?.lives_left).toBe(6);
    expect(rows.results?.[1]?.player_id).toBe(starterId);
    expect(rows.results?.[1]?.place).toBe(2);
    expect(rows.results?.[1]?.lives_left).toBe(0);

    const tableRow = await env.DB.prepare(`SELECT status FROM tables WHERE id = ?1`)
      .bind(tableId)
      .first<{ status: string }>();
    expect(tableRow?.status).toBe("finished");

    annaSocket.close();
    boSocket.close();
  });

  it("auto-plays a turn that nobody takes", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const tableId = await createTableRow("Timer", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    await annaSocket.nextState((view) => view.state.players.length === 2);

    // A one-second clock instead of sixty.
    await setTimings(tableId, FAST);
    annaSocket.send({ type: "start" });
    const started = await annaSocket.nextState((view) => view.state.round === 1);

    // Nobody rolls: the alarm plays the safest legal move for the idle opener.
    const autoPlayed = await annaSocket.nextState((view) => view.state.lastAnnouncement !== null, 10_000);
    expect(autoPlayed.state.lastAnnouncement?.value).toBe(31);
    expect(autoPlayed.state.lastAnnouncement?.playerId).toBe(started.state.turnPlayerId);
    // The auto-played player rolled for real, and still nobody else can see it.
    const visibleDice = autoPlayed.state.players.filter((player) => player.dice !== null);
    const expectedDiceHolders = autoPlayed.you === started.state.turnPlayerId ? 1 : 0;
    expect(visibleDice).toHaveLength(expectedDiceHolders);
    expect(autoPlayed.state.diceOwnerId).toBe(started.state.turnPlayerId);

    annaSocket.close();
    boSocket.close();
  }, 25_000);

  it("restores the roster from storage when the object reloads", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const tableId = await createTableRow("Persistence", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    await annaSocket.nextState((view) => view.state.players.length === 2);

    // The roster the object holds came back out of storage on the reload that
    // the previous request forced, so it is genuinely persisted state.
    const stored = await runInDurableObject(stubFor(tableId), async (instance, state) => {
      return await state.storage.get<MiaState>("room");
    });
    expect(stored?.players.map((player) => player.name).sort()).toEqual(["Anna", "Bo"]);
    expect(stored?.tableId).toBe(tableId);

    const row = await env.DB.prepare(`SELECT player_count FROM tables WHERE id = ?1`)
      .bind(tableId)
      .first<{ player_count: number }>();
    expect(row?.player_count).toBe(2);

    annaSocket.close();
    boSocket.close();
  });

  it("never clamps an alarm target into the past", () => {
    const now = Date.now();
    // A stale target is the hot loop's fuel: it must be nudged forward.
    expect(clampAlarmTime(now - 60_000, now)).toBeGreaterThan(now);
    expect(clampAlarmTime(now, now)).toBeGreaterThan(now);
    // A genuine future deadline is left exactly alone.
    expect(clampAlarmTime(now + 5_000, now)).toBe(now + 5_000);
  });

  it("reaps an abandoned finished table and schedules no further alarm", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const tableId = await createTableRow("Abandoned", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    await annaSocket.nextState((view) => view.state.players.length === 2);

    // Take a two-player table all the way to game over.
    annaSocket.send({ type: "start" });
    const started = await annaSocket.nextState((view) => view.state.round === 1);
    const starterId = started.state.turnPlayerId!;
    const openerSocket = starterId === anna.id ? annaSocket : boSocket;
    const otherSocket = starterId === anna.id ? boSocket : annaSocket;
    await setLives(tableId, starterId, 1);
    await waitFor(async () => (await readState(tableId))?.phase === "deciding");
    openerSocket.send({ type: "roll" });
    await openerSocket.nextState((view) => view.state.phase === "announcing");
    await forceDice(tableId, starterId, [3, 1]);
    openerSocket.send({ type: "announce", value: 65 });
    await openerSocket.nextState((view) => view.state.lastAnnouncement?.value === 65);
    otherSocket.send({ type: "doubt" });
    const finished = await openerSocket.nextState((view) => view.state.gameOver !== null, 6_000);
    expect(finished.state.phase).toBe("finished");

    // A short TTL, then both players close the tab without sending `leave` —
    // exactly the case the old phase dispatch could never reap.
    await setEmptyTtl(tableId, 1_500);
    annaSocket.close();
    boSocket.close();
    await waitFor(async () => (await socketCount(tableId)) === 0);

    // The room now holds a real finished game, and its reap alarm is armed in
    // the future — never in the past, which is what made it spin.
    expect(await storedRoom(tableId)).not.toBeNull();
    const armed = await scheduledAlarm(tableId);
    expect(armed).not.toBeNull();
    expect(armed!).toBeGreaterThan(Date.now());

    // Past the TTL the storage is gone and nothing is scheduled to wake the
    // object again.
    await waitForValue(async () => ((await storedRoom(tableId)) === null ? true : null), 8_000);
    expect(await scheduledAlarm(tableId)).toBeNull();
    // A completed game's row must not be relabelled on the way out.
    expect(await tableStatus(tableId)).toBe("finished");
  });

  it("records finishing places in elimination order, not seat order", async () => {
    const players = [];
    for (const name of ["Anna", "Bo", "Cara", "Dan"]) players.push(await makePlayer(name));
    const tableId = await createTableRow("Places", players[0]!.id);
    const sockets: TestSocket[] = [];
    for (const player of players) sockets.push(await connect(tableId, player));
    await sockets[0]!.nextState((view) => view.state.players.length === 4);

    await setTimings(tableId, DRIVE);
    sockets[0]!.send({ type: "start" });

    // Round 1: Anna (seat 0) bluffs, Bo catches it. Anna is out first.
    await waitForTurn(tableId, players[0]!.id);
    await setLives(tableId, players[0]!.id, 1);
    await driveRound(tableId, sockets[0]!, sockets[1]!, players[0]!.id, [3, 1], 65);

    // Round 2: Bo (seat 1) bluffs, Cara catches it. Bo is out second.
    await waitForTurn(tableId, players[1]!.id);
    await setLives(tableId, players[1]!.id, 1);
    await driveRound(tableId, sockets[1]!, sockets[2]!, players[1]!.id, [3, 1], 65);

    // Round 3: Cara (seat 2) really holds 66 but announces low, so Dan's doubt
    // costs Dan the life. Dan is out third and Cara wins — from the middle seat
    // that used to be recorded as places 2, 3 and 5 with a skipped 4.
    await waitForTurn(tableId, players[2]!.id);
    await setLives(tableId, players[3]!.id, 1);
    await driveRound(tableId, sockets[2]!, sockets[3]!, players[2]!.id, [6, 6], 31);

    await waitFor(async () => (await readState(tableId))?.gameOver !== null, 15_000);
    const finished = await readState(tableId);
    expect(finished?.gameOver?.winnerId).toBe(players[2]!.id);
    expect(finished?.players.map((player) => [player.id, player.eliminationIndex])).toEqual([
      [players[0]!.id, 1],
      [players[1]!.id, 2],
      [players[2]!.id, null],
      [players[3]!.id, 3],
    ]);

    const gameId = finished!.gameId;
    const rows = await waitForValue(async () => {
      const result = await env.DB.prepare(
        `SELECT player_id, place FROM game_players WHERE game_id = ?1 ORDER BY place ASC`,
      )
        .bind(gameId)
        .all<{ player_id: string; place: number }>();
      return (result.results?.length ?? 0) === 4 ? result.results! : null;
    });
    // Winner 1st, then everyone else in reverse elimination order — places 1-4
    // with no gap, not the seat-index 1, 2, 3, 5 the old formula produced.
    expect(rows.map((row) => [row.player_id, row.place])).toEqual([
      [players[2]!.id, 1],
      [players[3]!.id, 2],
      [players[1]!.id, 3],
      [players[0]!.id, 4],
    ]);

    for (const socket of sockets) socket.close();
  }, 45_000);

  it("backs a failed result write off without ever spinning", () => {
    expect(resultWriteBackoffMs(1)).toBe(1_000);
    expect(resultWriteBackoffMs(2)).toBe(2_000);
    expect(resultWriteBackoffMs(3)).toBe(4_000);
    expect(resultWriteBackoffMs(20)).toBe(5 * 60 * 1000);
  });

  it("retries a failed result write until it lands", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const tableId = await createTableRow("Flaky D1", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    await annaSocket.nextState((view) => view.state.players.length === 2);

    // The game-over write and the first retry both fail; the second retry lands.
    await armResultWriteFailures(tableId, 2);
    const gameId = await finishTwoPlayerGame(tableId, anna.id, [annaSocket, boSocket]);

    // The first attempt failed and armed a retry; D1 has nothing yet. The
    // retries then run on the real alarm clock (1s, then 2s of backoff).
    await waitFor(async () => (await resultWriteInternals(tableId)).retryAt !== null, 5_000);
    expect((await resultWriteInternals(tableId)).written).toBe(false);
    expect(await countResultRows(gameId)).toBe(0);
    expect(await tableStatus(tableId)).not.toBe("finished");

    const rows = await waitForValue(async () => {
      const result = await env.DB.prepare(`SELECT place FROM game_players WHERE game_id = ?1 ORDER BY place ASC`)
        .bind(gameId)
        .all<{ place: number }>();
      return result.results?.length === 2 ? result.results : null;
    }, 10_000);
    expect(rows.map((row) => row.place)).toEqual([1, 2]);

    const internals = await resultWriteInternals(tableId);
    expect(internals.written).toBe(true);
    expect(internals.attempts).toBeGreaterThanOrEqual(3);
    await waitFor(async () => (await tableStatus(tableId)) === "finished");

    annaSocket.close();
    boSocket.close();
  }, 30_000);

  it("retries a partial write without duplicating rows", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const tableId = await createTableRow("Partial write", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    await annaSocket.nextState((view) => view.state.players.length === 2);

    // The result rows land, then the finished-table sync fails. That is the
    // only shape that actually exercises `recordGame`'s idempotency: the retry
    // re-runs an INSERT whose rows are already there.
    await inRoom(tableId, (room) => room.__failFinishedSyncForTest(1));
    const gameId = await finishTwoPlayerGame(tableId, anna.id, [annaSocket, boSocket]);

    // The retry finishes the job...
    await waitFor(async () => (await tableStatus(tableId)) === "finished", 15_000);
    const internals = await resultWriteInternals(tableId);
    expect(internals.written).toBe(true);
    expect(internals.attempts).toBeGreaterThanOrEqual(2);

    // ...and the replayed INSERTs duplicated nothing.
    const games = await env.DB.prepare(`SELECT COUNT(*) AS n FROM games WHERE id = ?1`)
      .bind(gameId)
      .first<{ n: number }>();
    expect(games?.n).toBe(1);
    const playerRows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM game_players WHERE game_id = ?1`)
      .bind(gameId)
      .first<{ n: number }>();
    expect(playerRows?.n).toBe(2);
    expect(await countResultRows(gameId)).toBe(2);

    annaSocket.close();
    boSocket.close();
  }, 30_000);

  it("never reaps a finished game whose result never reached D1", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const tableId = await createTableRow("Unwritable D1", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    await annaSocket.nextState((view) => view.state.players.length === 2);

    // A D1 outage that outlasts the empty-table TTL.
    await armResultWriteFailures(tableId, 1_000);
    const gameId = await finishTwoPlayerGame(tableId, anna.id, [annaSocket, boSocket]);
    await waitFor(async () => (await resultWriteInternals(tableId)).retryAt !== null, 5_000);

    // Empty the room with a tiny TTL: the unwritten result must outlive it.
    await setEmptyTtl(tableId, 150);
    annaSocket.close();
    boSocket.close();
    await waitFor(async () => (await socketCount(tableId)) === 0, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Even a direct reap attempt on a room already past its TTL refuses while
    // the result is unwritten: that guard is the only thing between the game
    // and permanent loss.
    await inRoom(tableId, (room) => {
      (room as unknown as { emptySince: number | null }).emptySince = Date.now() - 10_000;
    });
    await inRoom(tableId, (room) =>
      (room as unknown as { maybeReapEmptyRoom(now: number): Promise<void> }).maybeReapEmptyRoom(Date.now()),
    );
    expect(await storedRoom(tableId)).not.toBeNull();
    expect(await tableStatus(tableId)).not.toBe("finished");
    expect(await countResultRows(gameId)).toBe(0);
    // Still awake and still retrying, rather than collected.
    expect(await scheduledAlarm(tableId)).not.toBeNull();

    // D1 recovers: the next retry writes the result and flips the table.
    await armResultWriteFailures(tableId, 0);
    expect(await runResultRetry(tableId)).toBe(true);
    const rows = await waitForValue(async () => {
      const result = await env.DB.prepare(`SELECT place FROM game_players WHERE game_id = ?1 ORDER BY place ASC`)
        .bind(gameId)
        .all<{ place: number }>();
      return result.results?.length === 2 ? result.results : null;
    });
    expect(rows.map((row) => row.place)).toEqual([1, 2]);
    await waitFor(async () => (await tableStatus(tableId)) === "finished");
  }, 30_000);

  it("retries a failed result write after the object reloads", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const tableId = await createTableRow("Reload", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    await annaSocket.nextState((view) => view.state.players.length === 2);

    await armResultWriteFailures(tableId, 1);
    const gameId = await finishTwoPlayerGame(tableId, anna.id, [annaSocket, boSocket]);
    await waitFor(async () => (await resultWriteInternals(tableId)).retryAt !== null, 5_000);

    // The finished game is persisted, but the written marker is not: D1 never
    // took it.
    const persisted = await runInDurableObject(stubFor(tableId), async (_instance, state) => ({
      room: await state.storage.get<MiaState>("room"),
      written: await state.storage.get<boolean>("resultsWritten"),
    }));
    expect(persisted.room?.gameOver).not.toBeNull();
    expect(persisted.written).toBeUndefined();

    // Evict the object, the way hibernation or a redeploy would. `abort`
    // deliberately fails the in-flight call with its reason, so that rejection
    // is expected here.
    await runInDurableObject(stubFor(tableId), (_instance, state) => {
      state.abort("test eviction");
    }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The reloaded object still sees a pending result and arms its own retry,
    // without waiting for a request.
    const afterLoad = await runInDurableObject(stubFor(tableId), async (instance, state) => ({
      pending: (instance as unknown as { hasPendingResults(): boolean }).hasPendingResults(),
      written: await state.storage.get<boolean>("resultsWritten"),
      alarm: await state.storage.getAlarm(),
    }));
    expect(afterLoad.pending).toBe(true);
    expect(afterLoad.written).toBeUndefined();
    expect(afterLoad.alarm).not.toBeNull();

    // The injected failure did not survive the reload, so the retry lands.
    expect(await runResultRetry(tableId)).toBe(true);
    const rows = await waitForValue(async () => {
      const result = await env.DB.prepare(`SELECT place FROM game_players WHERE game_id = ?1 ORDER BY place ASC`)
        .bind(gameId)
        .all<{ place: number }>();
      return result.results?.length === 2 ? result.results : null;
    });
    expect(rows.map((row) => row.place)).toEqual([1, 2]);
    await waitFor(async () => (await tableStatus(tableId)) === "finished");

    annaSocket.close();
    boSocket.close();
  }, 30_000);

  it("drops a pre-game host's seat when they close the tab, so the rest can start", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const cara = await makePlayer("Cara");
    const tableId = await createTableRow("Hostless", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    const caraSocket = await connect(tableId, cara);
    await caraSocket.nextState((view) => view.state.players.length === 3);
    await waitFor(async () => (await playerCount(tableId)) === 3);

    // The host closes the tab; no `leave` message is ever sent.
    annaSocket.close();
    const afterClose = await boSocket.nextState(
      (view) => view.state.players.length === 2 && !view.connected.includes(anna.id),
      5_000,
    );
    expect(afterClose.state.players.map((player) => player.name)).toEqual(["Bo", "Cara"]);
    expect([...afterClose.connected].sort()).toEqual([bo.id, cara.id].sort());

    // The D1 directory the lobby renders follows the live roster.
    await waitFor(async () => (await playerCount(tableId)) === 2);

    // Bo is now the first seat, so the table is startable again.
    boSocket.send({ type: "start" });
    const started = await boSocket.nextState((view) => view.state.round === 1);
    expect(started.state.players.map((player) => player.name)).toEqual(["Bo", "Cara"]);
    expect(boSocket.errors).toEqual([]);

    boSocket.close();
    caraSocket.close();
    // Let the close handlers finish before the runtime is torn down.
    await waitFor(async () => (await socketCount(tableId)) === 0, 5_000);
  }, 20_000);

  it("keeps a disconnected player's seat once the game is under way", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const tableId = await createTableRow("Mid-game drop", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    await annaSocket.nextState((view) => view.state.players.length === 2);

    annaSocket.send({ type: "start" });
    await annaSocket.nextState((view) => view.state.round === 1);

    // Anna's phone drops mid-game: her seat has to stay so her turns auto-play.
    annaSocket.close();
    const view = await boSocket.nextState((snapshot) => !snapshot.connected.includes(anna.id), 5_000);
    expect(view.state.players.map((player) => player.name)).toEqual(["Anna", "Bo"]);
    expect(await playerCount(tableId)).toBe(2);
    expect(await tableStatus(tableId)).toBe("playing");

    boSocket.close();
  }, 20_000);

  it("keeps a pre-game seat while the player still has another socket", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const tableId = await createTableRow("Two tabs", anna.id);
    const annaFirst = await connect(tableId, anna);
    const annaSecond = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    await boSocket.nextState((view) => view.state.players.length === 2);

    // One tab closes; Anna is still here in the other.
    annaFirst.close();
    await waitFor(async () => (await socketCount(tableId)) === 2);
    expect((await readState(tableId))?.players.map((player) => player.name)).toEqual(["Anna", "Bo"]);

    // The last socket closes, and only then does the seat go.
    annaSecond.close();
    await waitFor(async () => {
      const state = await readState(tableId);
      return state !== null && state.players.map((player) => player.name).join() === "Bo";
    });

    boSocket.close();
  }, 20_000);

  it("reaps an abandoned pre-game table past its TTL", async () => {
    const anna = await makePlayer("Anna");
    const tableId = await createTableRow("Abandoned lobby", anna.id);
    const annaSocket = await connect(tableId, anna);
    await annaSocket.nextState((view) => view.state.players.length === 1);
    await waitFor(async () => (await playerCount(tableId)) === 1);

    await setEmptyTtl(tableId, 150);
    annaSocket.close();

    // The seat goes first, and the lobby count follows it.
    await waitFor(async () => (await playerCount(tableId)) === 0);

    // Past the TTL the storage is dropped and nothing is left to wake it. This
    // is the commonest abandoned table of all: created, nobody joined, closed.
    await waitForValue(async () => ((await storedRoom(tableId)) === null ? true : null), 8_000);
    expect(await scheduledAlarm(tableId)).toBeNull();
    expect(await tableStatus(tableId)).toBe("abandoned");
  }, 20_000);

  it("lets the creator start even when someone else connected first", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    // Anna created the table in D1; the Durable Object learns that from the
    // upgrade header, not from who gets a socket first.
    const tableId = await createTableRow("Creator's table", anna.id);
    const boSocket = await connect(tableId, bo);
    await boSocket.nextState((view) => view.state.players.length === 1);
    const annaSocket = await connect(tableId, anna);
    await annaSocket.nextState((view) => view.state.players.length === 2);
    expect((await readState(tableId))?.players[0]?.id).toBe(bo.id); // Bo is seat 0

    // Bo is first in the roster but is not the creator: refused, and by name.
    boSocket.send({ type: "start" });
    await waitFor(() => boSocket.errors.length > 0);
    expect(boSocket.errors.join(" ")).toContain("Only Anna");

    // The creator can still start their own table.
    annaSocket.send({ type: "start" });
    const started = await annaSocket.nextState((view) => view.state.round === 1);
    expect(started.state.players.map((player) => player.name).sort()).toEqual(["Anna", "Bo"]);

    annaSocket.close();
    boSocket.close();
  }, 20_000);

  it("lets anyone start once the creator has gone", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const cara = await makePlayer("Cara");
    const tableId = await createTableRow("Creator leaves", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    const caraSocket = await connect(tableId, cara);
    await caraSocket.nextState((view) => view.state.players.length === 3);

    // The creator closes their tab; B5 drops the seat but `hostId` stays Anna's.
    annaSocket.close();
    await waitFor(async () => (await readState(tableId))?.players.length === 2);

    // Bo is not the creator, but the creator is not connected, so Bo may start.
    boSocket.send({ type: "start" });
    const started = await boSocket.nextState((view) => view.state.round === 1);
    expect(started.state.players.map((player) => player.name).sort()).toEqual(["Bo", "Cara"]);
    expect(boSocket.errors).toEqual([]);

    boSocket.close();
    caraSocket.close();
  }, 20_000);

  it("stops re-arming a wedged auto-play and lets the room be reaped", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const tableId = await createTableRow("Wedge", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    await annaSocket.nextState((view) => view.state.players.length === 2);
    annaSocket.send({ type: "start" });
    await annaSocket.nextState((view) => view.state.round === 1);

    // The wedge: an unknown player is on the clock with an expired deadline, so
    // `autoPlay` finds no move and changes nothing on every wake. That is the
    // 1 Hz loop the alarm used to run forever.
    await inRoom(tableId, async (room) => {
      const state = await room.__stateForTest();
      if (!state) throw new Error("no state");
      state.turnPlayerId = "ghost";
      state.phase = "deciding";
      state.deadlineAt = Date.now() - 1_000;
    });
    await setEmptyTtl(tableId, 200);
    annaSocket.close();
    boSocket.close();
    await waitFor(async () => (await socketCount(tableId)) === 0, 5_000);

    // Past the cap it stops re-arming, hands the room to the reaper, and the
    // storage goes. Without the cap this never happens.
    await waitForValue(async () => ((await storedRoom(tableId)) === null ? true : null), 25_000);
    expect(await scheduledAlarm(tableId)).toBeNull();
  }, 40_000);

  it("resolves an auto-played reveal into the next round", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const tableId = await createTableRow("Auto reveal", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    await annaSocket.nextState((view) => view.state.players.length === 2);
    await setTimings(tableId, FAST);
    annaSocket.send({ type: "start" });
    const started = await annaSocket.nextState((view) => view.state.round === 1);
    const starterId = started.state.turnPlayerId!;
    const starter = starterId === anna.id ? annaSocket : boSocket;

    // The opener claims a real Mia, then nobody acts: the idle player's clock
    // auto-plays the doubt, so the reveal is reached through `autoPlay` rather
    // than a player's move. The old early return skipped `ensureAlarm` there and
    // the table sat in `revealing` with no clock to resolve it.
    await waitFor(async () => (await readState(tableId))?.phase === "deciding");
    starter.send({ type: "roll" });
    await starter.nextState((view) => view.state.phase === "announcing");
    await forceDice(tableId, starterId, [2, 1]);
    starter.send({ type: "announce", value: 21 });
    await starter.nextState((view) => view.state.lastAnnouncement?.value === 21);

    const revealed = await starter.nextState((view) => view.state.phase === "revealing", 10_000);
    expect(revealed.state.pendingDoubt?.verdict).toBe("doubter");
    expect(await scheduledAlarm(tableId)).not.toBeNull();

    await waitFor(async () => (await readState(tableId))?.round === 2, 15_000);

    annaSocket.close();
    boSocket.close();
  }, 30_000);

  it("gives up on a result that never lands and lets the room go", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const tableId = await createTableRow("Give up", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    await annaSocket.nextState((view) => view.state.players.length === 2);

    // A short retry window and a D1 that never recovers. The sockets stay open
    // so the room stays warm and the injected failures are not lost.
    await inRoom(tableId, (room) => room.__setResultRetryWindowForTest(50));
    await setEmptyTtl(tableId, 150);
    await armResultWriteFailures(tableId, 1_000_000);
    const gameId = await finishTwoPlayerGame(tableId, anna.id, [annaSocket, boSocket]);

    // The first failure arms a retry; when it fails past the window the room
    // gives up: the payload is logged and no further retry is armed.
    await waitFor(async () => (await resultWriteInternals(tableId)).retryAt !== null, 5_000);
    await waitFor(async () => (await resultWriteInternals(tableId)).retryAt === null, 10_000);
    expect((await resultWriteInternals(tableId)).written).toBe(false);
    expect(await countResultRows(gameId)).toBe(0);

    // With nothing pending, the reaper can finally collect the room.
    annaSocket.close();
    boSocket.close();
    await waitForValue(async () => ((await storedRoom(tableId)) === null ? true : null), 20_000);
    expect(await scheduledAlarm(tableId)).toBeNull();
  }, 40_000);
});
