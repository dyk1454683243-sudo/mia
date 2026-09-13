/**
 * TableRoom integration tests: real Durable Object, real D1, real WebSockets,
 * driven inside workerd by @cloudflare/vitest-pool-workers.
 */
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Die, MiaState } from "../src/shared/mia";
import type { ServerMessage, StateView } from "../src/shared/protocol";
import { ensureSchema } from "../src/worker/db";
import { signCookie } from "../src/worker/session";
import { clampAlarmTime, type TableRoom } from "../src/worker/table-room";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** Fast clock for tests: a turn expires in a second. */
const FAST = { turnMs: 1_000, revealMs: 400, roundStartMs: 150 };

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
 * base class does not propagate, so the instance is narrowed back to the real
 * class here. The runtime value genuinely is a TableRoom.
 */
async function inRoom<T>(tableId: string, fn: (room: TableRoom) => T | Promise<T>): Promise<T> {
  return await runInDurableObject(stubFor(tableId), async (instance) => fn(instance as TableRoom));
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

  it("rejects illegal actions server-side", async () => {
    const anna = await makePlayer("Anna");
    const bo = await makePlayer("Bo");
    const tableId = await createTableRow("Illegal moves", anna.id);
    const annaSocket = await connect(tableId, anna);
    const boSocket = await connect(tableId, bo);
    await annaSocket.nextState((view) => view.state.players.length === 2);

    // Starting is the opener's call.
    boSocket.send({ type: "start" });
    await waitFor(() => boSocket.errors.length > 0);
    expect(boSocket.errors.join(" ")).toContain("opened the table");

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
  });
});
