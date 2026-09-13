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
  finalStandings,
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
/**
 * When the room last had zero live sockets. Persisted, not just in-memory:
 * this object hibernates between the disconnect and the reap alarm, and an
 * in-memory timestamp would reset on every cold start, so the TTL would roll
 * forward forever and storage would never actually be freed.
 */
const EMPTY_SINCE_KEY = "emptySince";
/**
 * Set once a finished game's result has actually reached D1. Persisted, and
 * deliberately *not* inferred from `state.gameOver`: a game being over says
 * nothing about whether its result was written, and treating the two as the
 * same is what silently dropped a result after a transient D1 error.
 */
const RESULTS_WRITTEN_KEY = "resultsWritten";
/** How long an emptied table is kept before its storage is dropped. */
const EMPTY_TABLE_TTL_MS = 60 * 60 * 1000;
/**
 * Floor for an alarm whose target time has already passed. `setAlarm` with a
 * past timestamp fires immediately, and because the target is recomputed from
 * an unchanged deadline it fires immediately again — the abandoned-table hot
 * loop. Nudging forward breaks the cycle while still waking promptly.
 */
const MIN_ALARM_DELAY_MS = 1_000;
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
  /** How long an empty room is kept before its storage is dropped. */
  private emptyTtlMs = EMPTY_TABLE_TTL_MS;
  /** Guards the one-shot D1 write when a game finishes. */
  private resultsWritten = false;
  /** Consecutive failed result-write attempts; drives the retry backoff. */
  private resultsAttempts = 0;
  /** Epoch ms of the next scheduled result-write retry, or null if none. */
  private resultsRetryAt: number | null = null;
  /** Total result-write attempts made by this room, for tests and diagnostics. */
  private resultWriteAttempts = 0;
  /** Test-only fault injection: the next N result writes throw, like a flaky D1. */
  private resultWriteFailures = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // `room` is the only game key, so every game write is atomic; the empty
    // timestamp and the written marker are independent keys that `deleteAll`
    // clears with it.
    ctx.blockConcurrencyWhile(async () => {
      const [stored, emptySince, written] = await Promise.all([
        ctx.storage.get<MiaState>(STATE_KEY),
        ctx.storage.get<number>(EMPTY_SINCE_KEY),
        ctx.storage.get<boolean>(RESULTS_WRITTEN_KEY),
      ]);
      if (stored && stored.tableId) {
        this.state = stored;
        // Only the persisted marker proves D1 has the result.
        this.resultsWritten = stored.gameOver !== null && written === true;
      }
      if (typeof emptySince === "number") this.emptySince = emptySince;
      // A finished game whose write never landed retries the moment we wake.
      if (this.hasPendingResults()) await this.scheduleAlarm(Date.now());
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
    await this.clearEmptySince();
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
        eliminationIndex: null,
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
      players: [
        {
          id: playerId,
          name,
          lives: STARTING_LIVES,
          dice: null,
          roundsPlayed: 0,
          eliminated: false,
          eliminationIndex: null,
        },
      ],
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
    await this.broadcast();
    await this.ensureAlarm();
  }

  // -------------------------------------------------------------------------
  // Alarm: turn clock, reveal beat, round beat, empty-table cleanup
  // -------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    const now = Date.now();

    // An unwritten result outranks everything else, including the reaper: it is
    // the only record that the game happened. Retry it until D1 takes it.
    if (this.hasPendingResults()) {
      await this.retryResults(now);
      return;
    }

    // An alarm with nobody connected and nothing left to service is the
    // abandonment case. This check comes *before* the phase dispatch on
    // purpose: a finished (or long-quiet) table matches no phase branch, and
    // falling through would reschedule the same stale deadline forever. It is
    // also independent of whether state still exists, so the reaper runs for
    // real tables and not just for rooms storage has already been dropped in.
    if (this.ctx.getWebSockets().length === 0 && !this.hasPendingWork(now)) {
      await this.maybeReapEmptyRoom(now);
      return;
    }

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
        await this.scheduleAlarm(deadline);
        return;
      }
      await this.autoPlay(now);
      return;
    }

    await this.ensureAlarm();
  }

  /**
   * True when the alarm still has something to do: a deadline in the future,
   * or a phase whose beat is due (an expired turn, a reveal to resolve, a round
   * start to hand off to) and therefore has to be serviced.
   */
  private hasPendingWork(now: number): boolean {
    const state = this.state;
    if (state === null) return false;
    if (state.deadlineAt !== null && state.deadlineAt > now) return true;
    if (state.roundEndsAt !== null && state.roundEndsAt > now) return true;
    return this.needsImmediateWake(state);
  }

  /**
   * A phase that is due now and must be serviced by a single wake. Callers
   * reach this only after the future-deadline checks have already failed, so a
   * `deciding`/`announcing` turn here is one whose clock has run out.
   */
  private needsImmediateWake(state: MiaState): boolean {
    if (state.phase === "revealing" || state.phase === "deciding" || state.phase === "announcing") return true;
    // A `roundStart` with no `roundEndsAt` is the pre-game lobby, which has
    // nothing to play and must not wake on a loop.
    return state.phase === "roundStart" && state.roundEndsAt !== null;
  }

  /** True while a finished game's result still has not reached D1. */
  private hasPendingResults(): boolean {
    return this.state !== null && this.state.gameOver !== null && !this.resultsWritten;
  }

  /** Retry the D1 result write once its backoff is due, then reschedule. */
  private async retryResults(now: number): Promise<void> {
    if (this.resultsRetryAt !== null && this.resultsRetryAt > now) {
      await this.scheduleAlarm(this.resultsRetryAt);
      return;
    }
    const state = this.state;
    if (state !== null) await this.writeResults(state);
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
      if (result.state.gameOver || result.state.phase === "revealing") break;
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
      await this.clearEmptySince();
      return;
    }
    // An unwritten result outlives the empty-table TTL. Try the write now and,
    // while it is still pending, keep the room alive rather than deleting the
    // only copy of a finished game.
    if (this.hasPendingResults()) {
      const state = this.state;
      if (state !== null) await this.writeResults(state);
      if (this.hasPendingResults()) {
        await this.ensureAlarm();
        return;
      }
    }
    if (this.emptySince === null) {
      // Persist the moment the room emptied so the TTL survives hibernation.
      this.emptySince = now;
      await this.ctx.storage.put(EMPTY_SINCE_KEY, now);
    }
    if (now - this.emptySince >= this.emptyTtlMs) {
      // Drop the state and schedule nothing: the alarm that woke us is
      // one-shot, so the object goes dormant and stops billing wakes. This is
      // the only place table storage is ever freed.
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      this.state = null;
      this.resultsWritten = false;
      this.emptySince = null;
      return;
    }
    await this.scheduleAlarm(this.emptySince + this.emptyTtlMs);
  }

  /** A socket is back: forget that the room was ever empty. */
  private async clearEmptySince(): Promise<void> {
    if (this.emptySince === null) return;
    this.emptySince = null;
    await this.ctx.storage.delete(EMPTY_SINCE_KEY);
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
    await this.resetResultsWrite();
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
    // A state that is not finished cannot have a written result; clear any
    // bookkeeping the previous game left behind.
    if (!next.gameOver && this.resultsWritten) await this.resetResultsWrite();
    await this.broadcast();
    if (next.gameOver) await this.writeResults(next);
  }

  private async persistAndBroadcast(): Promise<void> {
    if (this.state) await this.ctx.storage.put(STATE_KEY, this.state);
    await this.broadcast();
  }

  /**
   * Write the finished game to D1. Idempotent (`recordGame` is
   * `ON CONFLICT DO NOTHING`), so a retry after a partial failure is safe.
   * A failure arms the next retry on the alarm; it never gives up silently and
   * it never reports success it did not have.
   */
  private async writeResults(state: MiaState): Promise<void> {
    const gameOver = state.gameOver;
    if (this.resultsWritten || gameOver === null) return;
    // Places come from the engine's elimination order, never from the seat the
    // player happened to occupy in the roster.
    const players: FinalPlayer[] = finalStandings(state).map(({ player, place }) => ({
      playerId: player.id,
      name: player.name,
      place,
      livesLeft: player.lives,
      roundsPlayed: player.roundsPlayed,
    }));
    this.resultWriteAttempts += 1;
    try {
      // Test-only fault injection, so the retry path can be driven on purpose.
      if (this.resultWriteFailures > 0) {
        this.resultWriteFailures -= 1;
        throw new Error("stubbed D1 failure");
      }
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
      // Unlike the routine lobby syncs, a failure here must keep the retry
      // alive: otherwise the lobby keeps advertising a finished table.
      await this.syncTableRow("finished", true);
      // The marker goes down only after D1 has actually taken the rows.
      await this.ctx.storage.put(RESULTS_WRITTEN_KEY, true);
      this.resultsWritten = true;
      this.resultsAttempts = 0;
      this.resultsRetryAt = null;
    } catch (error) {
      this.resultsAttempts += 1;
      const backoff = resultWriteBackoffMs(this.resultsAttempts);
      this.resultsRetryAt = Date.now() + backoff;
      console.error(
        `failed to record game result (attempt ${this.resultsAttempts}); retrying in ${backoff}ms`,
        describe(error),
      );
      // Arm the retry here as well as through `ensureAlarm`: a caller that
      // returns immediately on game over never reaches `ensureAlarm`.
      await this.scheduleAlarm(this.resultsRetryAt);
    }
  }

  /** Clear the result-write bookkeeping, e.g. when a fresh game starts. */
  private async resetResultsWrite(): Promise<void> {
    this.resultsWritten = false;
    this.resultsAttempts = 0;
    this.resultsRetryAt = null;
    this.resultWriteAttempts = 0;
    await this.ctx.storage.delete(RESULTS_WRITTEN_KEY);
  }

  /** Keep the D1 lobby directory in step with this table. */
  private async syncTableRow(status?: RoomStatus, throwOnError = false): Promise<void> {
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
      if (throwOnError) throw error;
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

  /** The only way this class arms an alarm, so no target can be in the past. */
  private async scheduleAlarm(target: number): Promise<void> {
    await this.ctx.storage.setAlarm(clampAlarmTime(target, Date.now()));
  }

  private async ensureAlarm(): Promise<void> {
    const state = this.state;
    const now = Date.now();

    if (state !== null && state.gameOver !== null && !this.resultsWritten) {
      // Keep the room awake until its result reaches D1. Nothing else matters
      // once the game is over, and the retry must outrank the reaper.
      await this.scheduleAlarm(this.resultsRetryAt ?? now);
      return;
    }

    if (state !== null) {
      if (state.deadlineAt !== null && state.deadlineAt > now) {
        await this.scheduleAlarm(state.deadlineAt);
        return;
      }
      if (state.roundEndsAt !== null && state.roundEndsAt > now) {
        await this.scheduleAlarm(state.roundEndsAt);
        return;
      }
      if (this.needsImmediateWake(state)) {
        // The beat is already due — its deadline passed without an alarm, or
        // auto-play handed the turn to a seat nobody is sitting at. Wake once,
        // just ahead of now rather than in the past.
        await this.scheduleAlarm(now);
        return;
      }
    }

    if (this.ctx.getWebSockets().length === 0) {
      // Nobody connected and nothing to play: keep exactly one reap alarm
      // pending. This is the only path that can compute a stale target, so it
      // goes through `scheduleAlarm` rather than `setAlarm` directly.
      await this.maybeReapEmptyRoom(now);
      return;
    }

    await this.ctx.storage.deleteAlarm();
  }
}

/**
 * Never hand `setAlarm` a timestamp in the past. A past alarm fires at once,
 * and if the target is recomputed from an unchanged deadline it fires at once
 * again, forever. Clamp forward by a small floor instead.
 */
export function clampAlarmTime(target: number, now: number): number {
  return target > now ? target : now + MIN_ALARM_DELAY_MS;
}

/**
 * Backoff for a failed result write: 1s, 2s, 4s ... capped at five minutes.
 * Capped rather than unbounded so a recovered D1 is picked up promptly, and
 * never zero so a hard failure cannot spin the alarm.
 */
export function resultWriteBackoffMs(attempts: number): number {
  const base = 1_000;
  const cap = 5 * 60 * 1000;
  return Math.min(base * 2 ** Math.max(0, attempts - 1), cap);
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
