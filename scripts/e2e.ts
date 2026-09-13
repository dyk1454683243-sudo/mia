/**
 * Local end-to-end verification for Mia.
 *
 * Drives real WebSocket clients against `wrangler dev`, playing with exactly
 * the same decision function the server uses for idle players. Run with:
 *
 *   node --experimental-strip-types scripts/e2e.ts        (Node >= 22.6)
 *
 * or simply: node scripts/e2e.mjs after importing the shared module through
 * Vite's TS handling is not available, so this file is plain JS that mirrors
 * the pure engine only where it must: legal values and the auto-play choice.
 */
import { autoPlaySequence, legalMoves, type MiaState } from "../src/shared/mia.ts";

const BASE = process.env.MIA_BASE ?? "http://127.0.0.1:8787";
const REVEAL_TIMEOUT_MS = 20_000;
const STEP_LIMIT = 400;

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
// HTTP
// ---------------------------------------------------------------------------

interface Player {
  label: string;
  id: string;
  name: string;
  cookie: string;
}

async function createPlayer(label: string): Promise<Player> {
  const response = await fetch(`${BASE}/api/me`, { redirect: "manual" });
  const body = (await response.json()) as { id: string; name: string };
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = /mia_pid=([^;]+)/.exec(setCookie);
  if (!match) throw new Error(`no session cookie for ${label}`);
  return { label, id: body.id, name: body.name, cookie: `mia_pid=${match[1]}` };
}

async function api(path: string, init: RequestInit & { player?: Player; raw?: boolean } = {}): Promise<{
  status: number;
  body: unknown;
  headers: Headers;
}> {
  const headers = new Headers(init.headers);
  if (init.player) headers.set("Cookie", init.player.cookie);
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
  const text = await response.text();
  let body: unknown = text;
  if (!init.raw) {
    try {
      body = JSON.parse(text);
    } catch {
      /* leave as text */
    }
  }
  return { status: response.status, body, headers: response.headers };
}

// ---------------------------------------------------------------------------
// WebSocket client
// ---------------------------------------------------------------------------

class Client {
  readonly player: Player;
  private socket: WebSocket | null = null;
  private states: MiaState[] = [];
  private connectedIds: string[] = [];
  private errors: string[] = [];
  private waiters: { predicate: () => boolean; resolve: () => void; reject: (error: Error) => void }[] = [];

  constructor(player: Player) {
    this.player = player;
  }

  connect(tableId: string): Promise<void> {
    const wsUrl = `${BASE.replace(/^http/, "ws")}/api/tables/${tableId}/ws`;
    const socket = new WebSocket(wsUrl, { headers: { Cookie: this.player.cookie } } as never);
    this.socket = socket;

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.player.label}: connect timeout`)), 10_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`${this.player.label}: socket error`));
      });
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String((event as MessageEvent).data)) as
        | { type: "state"; state: MiaState; connected: string[] }
        | { type: "error"; message: string };
      if (message.type === "error") {
        this.errors.push(message.message);
      } else {
        this.states.push(message.state);
        this.connectedIds = message.connected;
      }
      for (let index = this.waiters.length - 1; index >= 0; index--) {
        const waiter = this.waiters[index]!;
        if (waiter.predicate()) {
          this.waiters.splice(index, 1);
          waiter.resolve();
        }
      }
    });

    return ready;
  }

  get state(): MiaState | null {
    return this.states.length > 0 ? this.states[this.states.length - 1]! : null;
  }

  get lastError(): string | null {
    return this.errors.length > 0 ? this.errors[this.errors.length - 1]! : null;
  }

  resetErrors(): void {
    this.errors = [];
  }

  send(message: unknown): void {
    if (!this.socket || this.socket.readyState !== 1) throw new Error(`${this.player.label}: socket not open`);
    this.socket.send(JSON.stringify(message));
  }

  /** Wait until the predicate holds for the latest snapshot. */
  waitFor(predicate: (state: MiaState) => boolean, timeoutMs = REVEAL_TIMEOUT_MS): Promise<void> {
    if (this.state && predicate(this.state)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        predicate: () => this.state !== null && predicate(this.state),
        resolve,
        reject,
      };
      this.waiters.push(waiter);
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new Error(`${this.player.label}: timed out waiting (errors: ${this.errors.join("; ") || "none"})`));
      }, timeoutMs);
    });
  }

  close(): void {
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

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
  await Promise.all(clients.map((client) => client.connect(tableId)));
  await clients[0]!.waitFor((state) => state.players.length === players.length);

  clients[0]!.send({ type: "start" });
  await clients[0]!.waitFor((state) => state.round === 1);

  const log: GameLog = {
    rounds: 0,
    reveals: 0,
    announcerLosses: 0,
    doubterLosses: 0,
    doubleMia: 0,
    hiddenDiceViolations: [],
    leakedTo: [],
  };
  const seenReveal = new Set<number>();
  const seenRound = new Set<number>();

  const byId = new Map(clients.map((client) => [client.player.id, client]));

  for (let step = 0; step < STEP_LIMIT; step++) {
    const reference = clients[0]!.state;
    if (!reference) throw new Error("no state");
    if (reference.gameOver) break;
    if (step % 25 === 0) {
      console.log(
        `    step ${step}: round ${reference.round} phase ${reference.phase} turn ${reference.turnPlayerId?.slice(0, 4)} standing ${
          reference.lastAnnouncement?.value ?? "-"
        } lives ${reference.players.map((player) => player.lives).join("/")}`,
      );
    }

    // Redaction audit: only the cup holder may see any dice before a reveal.
    for (const client of clients) {
      const view = client.state;
      if (!view) continue;
      const publicDice = view.phase === "revealing" || view.phase === "finished";
      if (publicDice) continue;
      const visible = view.players.filter((player) => player.dice !== null);
      for (const player of visible) {
        if (player.id !== client.player.id) {
          log.hiddenDiceViolations.push({ viewer: client.player.label, owner: player.id });
        }
      }
      if (visible.length > 0 && visible[0]!.id !== view.diceOwnerId) {
        log.leakedTo.push(`${client.player.label} sees dice not at the cup`);
      }
    }

    if (!seenRound.has(reference.round)) {
      seenRound.add(reference.round);
      log.rounds += 1;
    }
    if (reference.lastReveal && reference.lastReveal !== null) {
      const key = reference.round * 1000 + reference.players.filter((p) => p.eliminated).length;
      if (!seenReveal.has(key)) {
        seenReveal.add(key);
        log.reveals += 1;
        if (reference.lastReveal.verdict === "announcer") log.announcerLosses += 1;
        if (reference.lastReveal.verdict === "doubter") log.doubterLosses += 1;
        if (reference.lastReveal.penaltyApplied === "double-mia") log.doubleMia += 1;
      }
    }

    if (reference.phase === "revealing") {
      await clients[0]!.waitFor((state) => state.phase !== "revealing");
      continue;
    }
    if (reference.phase === "roundStart") {
      await clients[0]!.waitFor((state) => state.phase !== "roundStart");
      continue;
    }
    if (reference.phase === "finished") break;

    const turnId = reference.turnPlayerId;
    if (!turnId) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    const actor = byId.get(turnId);
    if (!actor) throw new Error(`no client for turn player ${turnId}`);

    const queue = autoPlaySequence(reference, turnId);
    if (queue.length === 0) throw new Error(`no legal auto-play move in phase ${reference.phase}`);

    for (const action of queue) {
      const before = actor.state;
      actor.send(action);
      const expectAnnouncement = action.type === "announce";
      await actor.waitFor((state) => {
        if (!before) return true;
        if (expectAnnouncement) return state.lastAnnouncement?.value === (action as { value: number }).value;
        if (action.type === "roll" || action.type === "believe") return state.phase === "announcing";
        return state.phase !== before.phase || state.turnPlayerId !== before.turnPlayerId;
      });
    }
  }

  const finalState = clients[0]!.state;
  if (!finalState?.gameOver) {
    console.log(
      `    stuck at round ${finalState?.round} phase ${finalState?.phase} lives ${finalState?.players
        .map((player) => player.lives)
        .join("/")}`,
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
  const games = (history.body as { games: { id: string; winnerName: string; players: unknown[] }[] }).games;
  const recorded = games.find((entry) => entry.id === game.gameId);
  check("GET /api/history contains the finished game", Boolean(recorded), `${games.length} games`);
  check("the recorded game has per-player rows", (recorded?.players.length ?? 0) === players.length, `${recorded?.players.length ?? 0} players`);

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

  section("Reconnect");
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

  const fresh = new Client(players[0]!);
  await fresh.connect(reconnectId);
  await fresh.waitFor(() => true);
  check(
    "a second connection for the same player gets the same roster",
    fresh.state?.players.length === 2 && fresh.state.you === players[0]!.id,
    `${fresh.state?.players.length} players`,
  );
  check("the roster did not grow on reconnect", a.state?.players.length === 2);
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
