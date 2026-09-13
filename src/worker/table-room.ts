/**
 * TableRoom — one Durable Object per table.
 *
 * Owns all live game state and the table's WebSockets. Uses the WebSocket
 * Hibernation API so an idle table costs nothing, and a single alarm for both
 * the 60-second turn clock and the reveal/round beats.
 */
import { DurableObject } from "cloudflare:workers";
import {
  applyAction,
  autoPlaySequence,
  beginRoundPlay,
  createGameState,
  DEFAULT_TIMINGS,
  type Die,
  type MiaAction,
  type MiaState,
  playerById,
  resolveReveal,
  type Seat,
  STARTING_LIVES,
  type Timings,
} from "../shared/mia";
import type { ClientMessage, ServerMessage, StateView } from "../shared/protocol";
import { recordGame, updateTable, type FinalPlayer } from "./db";

const STATE_KEY = "room";
/** How long an emptied table is kept before its storage is dropped. */
const EMPTY_TABLE_TTL_MS = 60 * 60 * 1000;
const MAX_PLAYERS = 8;

interface SocketAttachment {
  playerId: string;
  name: string;
}

type RoomStatus = "waiting" | "playing" | "finished";

export class TableRoom extends DurableObject<Env> {
  private state: MiaState | null = null;
  private timings: Timings = DEFAULT_TIMINGS;
  /** Epoch ms at which the room last had zero live sockets. */
  private emptySince: number | null = null;
  /** Guards the one-shot D1 write when a game finishes. */
  private resultsWritten = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The only persisted key is `room`, so every write is atomic.
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<MiaState>(STATE_KEY);
      if (stored && stored.tableId) {
        this.state = stored;
        this.resultsWritten = stored.gameOver !== null;
      }
    });
  }

  // -------------------------------------------------------------------------
  // WebSocket entry point
  // -------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    const playerId = request.headers.get("X-Mia-Player");
    // Names arrive percent-encoded because headers are latin-1 and ship names
    // are full of spaces; forgetting to decode leaves "Unacceptable%20Behaviour"
    // in the roster, the event log and the D1 result rows.
    const playerName = decodeHeader(request.headers.get("X-Mia-Name"));
    if (!playerId || !playerName) {
      return new Response("Missing player identity.", { status: 401 });
    }
    const tableName = decodeHeader(request.headers.get("X-Mia-Table-Name")) || "Table";
    // The Durable Object's own name is not reliably available, so the Worker
    // passes the canonical table id through with the upgrade.
    const tableId = request.headers.get("X-Mia-Table-Id") ?? "unknown";

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hibernation: both the socket and its tag survive eviction.
    this.ctx.acceptWebSocket(server, [playerId]);
    server.serializeAttachment({ playerId, name: playerName } satisfies SocketAttachment);

    await this.handleConnect(playerId, playerName, tableName, tableId);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleConnect(playerId: string, name: string, tableName: string, tableId: string): Promise<void> {
    this.emptySince = null;
    const state = this.state;

    if (state === null) {
      // No game yet: this is a lobby seat. The roster lives in the DO so a
      // pre-game table keeps its list of who is waiting.
      this.state = this.newLobbyState(playerId, name, tableName, tableId);
      await this.persistAndBroadcast();
      await this.syncTableRow();
      return;
    }

    const existing = playerById(state, playerId);
    if (!existing) {
      if (state.round > 0) {
        this.sendTo(playerId, {
          type: "error",
          message: "That game already started. Ask for a new table.",
        });
        const view = this.redactedFor(playerId);
        if (view) this.sendTo(playerId, view);
        return;
      }
      if (state.players.length >= MAX_PLAYERS) {
        this.sendTo(playerId, { type: "error", message: `That table is full (${MAX_PLAYERS} players).` });
        return;
      }
      state.players.push({
        id: playerId,
        name,
        lives: STARTING_LIVES,
        dice: null,
        roundsPlayed: 0,
        eliminated: false,
      });
      state.tableName = tableName;
    } else if (existing.name !== name) {
      existing.name = name;
    }

    // A returning player is a reconnect: they get the current snapshot and
    // nothing about the game changes.
    await this.persistAndBroadcast();
    await this.syncTableRow();
  }

  private newLobbyState(playerId: string, name: string, tableName: string, tableId: string): MiaState {
    return {
      tableId,
      tableName,
      gameId: "",
      startedAt: null,
      phase: "roundStart",
      round: 0,
      players: [{ id: playerId, name, lives: STARTING_LIVES, dice: null, roundsPlayed: 0, eliminated: false }],
      turnPlayerId: null,
      turnStartedAt: null,
      deadlineAt: null,
      diceOwnerId: null,
      lastAnnouncement: null,
      pendingDoubt: null,
      lastReveal: null,
      lastLoss: null,
      nextStarterId: null,
      events: [],
      logSeq: 0,
      roundEndsAt: null,
      gameOver: null,
    };
  }

  // -------------------------------------------------------------------------
  // Hibernation handlers
  // -------------------------------------------------------------------------

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return;
    if (typeof message !== "string") return;

    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(message) as ClientMessage;
    } catch {
      this.send(ws, { type: "error", message: "Malformed message." });
      return;
    }
    if (!parsed || typeof parsed.type !== "string") {
      this.send(ws, { type: "error", message: "Malformed message." });
      return;
    }

    try {
      await this.handleMessage(attachment.playerId, parsed);
    } catch (error) {
      this.send(ws, { type: "error", message: `Server error: ${describe(error)}` });
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    try {
      ws.close(code === 1000 ? 1000 : 1001, reason);
    } catch {
      /* already closing */
    }
    await this.afterDisconnect();
  }

  override async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    await this.afterDisconnect();
  }

  private async afterDisconnect(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) this.emptySince = Date.now();
    await this.broadcast();
    await this.ensureAlarm();
  }

  // -------------------------------------------------------------------------
  // Alarm: turn clock, reveal beat, round beat, empty-table cleanup
  // -------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    const now = Date.now();
    const state = this.state;

    if (state === null) {
      await this.maybeReapEmptyRoom(now);
      return;
    }

    if (state.phase === "revealing") {
      const next = resolveReveal(state, this.timings, now);
      await this.commit(next);
      await this.ensureAlarm();
      return;
    }

    if (state.phase === "roundStart" && state.roundEndsAt !== null && state.roundEndsAt <= now) {
      const next = structuredClone(state);
      beginRoundPlay(next, this.timings, now);
      await this.commit(next);
      await this.playOnBehalfOfTurn(now);
      await this.ensureAlarm();
      return;
    }

    if (state.phase === "deciding" || state.phase === "announcing") {
      const deadline = state.deadlineAt;
      if (deadline !== null && deadline > now) {
        await this.ctx.storage.setAlarm(deadline);
        return;
      }
      await this.autoPlay(now);
      return;
    }

    await this.ensureAlarm();
  }

  /** The idle player's safest legal move — the game must never stall. */
  private async autoPlay(now: number): Promise<void> {
    const state = this.state;
    if (state === null) return;
    const playerId = state.turnPlayerId;
    if (playerId === null) {
      await this.ensureAlarm();
      return;
    }
    const queue = autoPlaySequence(state, playerId);
    if (queue.length === 0) {
      await this.ensureAlarm();
      return;
    }
    for (const action of queue) {
      const current = this.state;
      if (current === null) return;
      const result = applyAction(current, action, this.timings, now);
      if (!result.ok) {
        console.error("auto-play rejected", result.error.message);
        break;
      }
      await this.commit(result.state);
      if (result.state.gameOver || result.state.phase === "revealing") return;
    }
    await this.playOnBehalfOfTurn(now);
    await this.ensureAlarm();
  }

  /** Play on for any seat that has nobody connected to act for it. */
  private async playOnBehalfOfTurn(now: number): Promise<void> {
    for (let guard = 0; guard < 64; guard++) {
      const state = this.state;
      if (state === null) return;
      if (state.phase !== "deciding" && state.phase !== "announcing") return;
      const turn = state.turnPlayerId;
      if (turn === null) return;
      const player = playerById(state, turn);
      if (player && !player.eliminated && this.isConnected(turn)) return;
      const queue = autoPlaySequence(state, turn);
      if (queue.length === 0) return;
      let advanced = false;
      for (const action of queue) {
        const current = this.state;
        if (current === null) return;
        const result = applyAction(current, action, this.timings, now);
        if (!result.ok) {
          console.error("auto-play rejected", result.error.message);
          return;
        }
        await this.commit(result.state);
        advanced = true;
        if (result.state.gameOver || result.state.phase === "revealing") return;
      }
      if (!advanced) return;
    }
  }

  private async maybeReapEmptyRoom(now: number): Promise<void> {
    if (this.ctx.getWebSockets().length > 0) {
      this.emptySince = null;
      return;
    }
    this.emptySince ??= now;
    if (now - this.emptySince > EMPTY_TABLE_TTL_MS) {
      await this.ctx.storage.deleteAll();
      this.state = null;
      this.emptySince = null;
      return;
    }
    await this.ctx.storage.setAlarm(this.emptySince + EMPTY_TABLE_TTL_MS);
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private async handleMessage(playerId: string, message: ClientMessage): Promise<void> {
    switch (message.type) {
      case "ping":
        await this.broadcast();
        return;
      case "start":
        await this.handleStart(playerId);
        return;
      case "roll":
        await this.applyAndContinue(playerId, { type: "roll", playerId });
        return;
      case "believe":
        await this.applyAndContinue(playerId, { type: "believe", playerId });
        return;
      case "announce": {
        if (typeof message.value !== "number" || !Number.isInteger(message.value)) {
          await this.reportError(playerId, "Malformed announcement.");
          return;
        }
        await this.applyAndContinue(playerId, { type: "announce", playerId, value: message.value });
        return;
      }
      case "doubt":
        await this.applyAndContinue(playerId, { type: "doubt", playerId });
        return;
      case "leave":
        await this.handleLeave(playerId);
        return;
      default:
        await this.reportError(playerId, "Unknown message.");
    }
  }

  private async handleStart(playerId: string): Promise<void> {
    const state = this.state;
    if (state === null) {
      await this.reportError(playerId, "Nobody is at this table yet.");
      return;
    }
    if (state.round > 0) {
      await this.reportError(playerId, "The game already started.");
      return;
    }
    if (state.players.length < 2) {
      await this.reportError(playerId, "You need at least 2 players to start.");
      return;
    }
    const [host] = state.players;
    if (host?.id !== playerId) {
      await this.reportError(playerId, "Only the player who opened the table can start.");
      return;
    }

    const seats: Seat[] = state.players.map((player) => ({ id: player.id, name: player.name }));
    const next = createGameState(this.tableId(), state.tableName, seats);
    this.resultsWritten = false;
    await this.commit(next);
    await this.syncTableRow("playing");
    await this.ensureAlarm();
  }

  private async handleLeave(playerId: string): Promise<void> {
    const state = this.state;
    if (state === null) return;
    if (state.round > 0) {
      // Mid-game a player cannot simply vanish from the roster; their turns
      // auto-play on the clock instead.
      await this.reportError(playerId, "You cannot leave mid-game — your turns will auto-play.");
      return;
    }
    const index = state.players.findIndex((player) => player.id === playerId);
    if (index === -1) return;
    const next = structuredClone(state);
    next.players.splice(index, 1);
    await this.commit(next);
    await this.syncTableRow();
  }

  /** Apply a player action, then hand the turn on (auto-playing dead seats). */
  private async applyAndContinue(playerId: string, action: MiaAction): Promise<void> {
    const state = this.state;
    if (state === null) {
      await this.reportError(playerId, "No game is running.");
      return;
    }
    const result = applyAction(state, action, this.timings, Date.now());
    if (!result.ok) {
      await this.reportError(playerId, result.error.message);
      return;
    }
    await this.commit(result.state);
    if (result.state.gameOver) return;
    // roll/believe/doubt all leave the next decision to a clock or a reveal;
    // only an announcement immediately hands the turn to the next player.
    if (action.type === "announce") {
      await this.playOnBehalfOfTurn(Date.now());
    }
    await this.ensureAlarm();
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private tableId(): string {
    return this.state?.tableId || "unknown";
  }

  /** Persist first, then swap into memory, then tell everyone. */
  private async commit(next: MiaState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, next);
    this.state = next;
    if (!next.gameOver) this.resultsWritten = false;
    await this.broadcast();
    if (next.gameOver) await this.writeResults(next);
  }

  private async persistAndBroadcast(): Promise<void> {
    if (this.state) await this.ctx.storage.put(STATE_KEY, this.state);
    await this.broadcast();
  }

  private async writeResults(state: MiaState): Promise<void> {
    const gameOver = state.gameOver;
    if (this.resultsWritten || gameOver === null) return;
    const players: FinalPlayer[] = state.players.map((player, index) => ({
      playerId: player.id,
      name: player.name,
      place: player.id === gameOver.winnerId ? 1 : index + 2,
      livesLeft: player.lives,
      roundsPlayed: player.roundsPlayed,
    }));
    try {
      await recordGame(this.env, {
        id: state.gameId,
        tableId: state.tableId,
        tableName: state.tableName,
        startedAt: state.startedAt ?? gameOver.finishedAt,
        finishedAt: gameOver.finishedAt,
        winnerId: gameOver.winnerId,
        winnerName: gameOver.winnerName,
        players,
      });
      await this.syncTableRow("finished");
      this.resultsWritten = true;
    } catch (error) {
      // Leave resultsWritten false: the next load retries the write.
      console.error("failed to record game result", describe(error));
    }
  }

  /** Keep the D1 lobby directory in step with this table. */
  private async syncTableRow(status?: RoomStatus): Promise<void> {
    const state = this.state;
    if (state === null) return;
    try {
      await updateTable(this.env, this.tableId(), {
        playerCount: state.players.length,
        now: Date.now(),
        ...(status ? { status } : {}),
      });
    } catch (error) {
      console.error("failed to sync table row", describe(error));
    }
  }

  // -------------------------------------------------------------------------
  // Broadcasting
  // -------------------------------------------------------------------------

  private redactedFor(viewerId: string): StateView | null {
    const state = this.state;
    if (state === null) return null;
    return {
      type: "state",
      state: redactFor(state, viewerId),
      you: viewerId,
      deadlineAt: state.deadlineAt,
      serverTime: Date.now(),
      connected: [...this.connectedIds()],
    };
  }

  /** One snapshot per recipient, because dice are redacted per viewer. */
  private async broadcast(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;
    const state = this.state;
    if (state === null) return;
    const connected = [...this.connectedIds()];

    for (const socket of sockets) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment) continue;
      this.send(socket, {
        type: "state",
        state: redactFor(state, attachment.playerId),
        you: attachment.playerId,
        deadlineAt: state.deadlineAt,
        serverTime: Date.now(),
        connected,
      });
    }
  }

  private connectedIds(): Set<string> {
    const ids = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment) ids.add(attachment.playerId);
    }
    return ids;
  }

  private isConnected(playerId: string): boolean {
    for (const socket of this.ctx.getWebSockets(playerId)) {
      if (socket.deserializeAttachment()) return true;
    }
    return false;
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      /* socket is gone; the close handler will clean up */
    }
  }

  private sendTo(playerId: string, message: ServerMessage): void {
    for (const socket of this.ctx.getWebSockets(playerId)) {
      this.send(socket, message);
    }
  }

  private async reportError(playerId: string, message: string): Promise<void> {
    this.sendTo(playerId, { type: "error", message });
    // Follow with a snapshot so a desynced client is pulled back in line.
    const view = this.redactedFor(playerId);
    if (view) this.sendTo(playerId, view);
  }

  /**
   * Test seam: force the dice in front of a player, so a table can be driven
   * through a specific bluff or a real Mia. Public because the vitest
   * integration reaches instance methods over RPC. Production code never calls
   * this — every other route into the state rolls real dice.
   */
  async __setDiceForTest(playerId: string, dice: [Die, Die]): Promise<MiaState> {
    const state = this.state;
    if (state === null) throw new Error("no game state");
    const next = structuredClone(state);
    const player = playerById(next, playerId);
    if (!player) throw new Error("unknown player");
    player.dice = dice;
    next.diceOwnerId = playerId;
    await this.commit(next);
    return next;
  }

  /** Test seam: read the unredacted server-side state. */
  async __stateForTest(): Promise<MiaState | null> {
    return this.state;
  }

  /** Test seam: shorten the clock so timers can be exercised in milliseconds. */
  async __setTimingsForTest(timings: Timings): Promise<void> {
    this.timings = timings;
  }

  private async ensureAlarm(): Promise<void> {
    const state = this.state;
    const now = Date.now();
    if (state === null) {
      this.emptySince ??= now;
      await this.ctx.storage.setAlarm(this.emptySince + EMPTY_TABLE_TTL_MS);
      return;
    }
    if (state.deadlineAt !== null && state.deadlineAt > now) {
      await this.ctx.storage.setAlarm(state.deadlineAt);
      return;
    }
    if (state.roundEndsAt !== null && state.roundEndsAt > now) {
      await this.ctx.storage.setAlarm(state.roundEndsAt);
      return;
    }
    if (this.ctx.getWebSockets().length === 0) {
      this.emptySince ??= now;
      await this.ctx.storage.setAlarm(this.emptySince + EMPTY_TABLE_TTL_MS);
      return;
    }
    if (state.phase === "deciding" || state.phase === "announcing" || state.phase === "roundStart") {
      await this.ctx.storage.setAlarm(now + 1_000);
      return;
    }
    await this.ctx.storage.deleteAlarm();
  }
}

/**
 * Redact hidden dice for one viewer. Dice belong to the player holding the cup
 * and become public the moment a doubt is called or the game ends.
 */
function redactFor(state: MiaState, viewerId: string): MiaState {
  const view = structuredClone(state);
  const publicDice = view.phase === "revealing" || view.phase === "finished";
  if (!publicDice) {
    // Only the player holding the cup may see any dice at all. The cup stays
    // with the last roller until the next round is seeded, which is what makes
    // this a state question rather than a phase question.
    const mine = view.diceOwnerId === viewerId ? viewerId : null;
    for (const player of view.players) {
      if (player.id !== mine) player.dice = null;
    }
  }
  return view;
}

/** Decode a percent-encoded header, tolerating malformed input. */
function decodeHeader(raw: string | null): string {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
