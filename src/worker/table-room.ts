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
  buildView,
  createGameState,
  DEFAULT_TIMINGS,
  type Die,
  finalStandings,
  type MiaAction,
  type MiaState,
  MAX_PLAYERS,
  MIN_PLAYERS,
  normalizeState,
  playerById,
  type MiaPlayer,
  resolveReveal,
  type Seat,
  STARTING_LIVES,
  type Timings,
} from "../shared/mia";
import type { ClientMessage, ErrorCode, ServerMessage, StateView } from "../shared/protocol";
import {
  clearTableSeats,
  createRematchTable,
  recordGame,
  readTableSeats,
  type FinalPlayer,
  type SeededPlayer,
  updateTable,
} from "./db";

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
/**
 * When the result write first failed. Persisted, so a room that hibernates
 * between retries still measures the window from the start of the outage
 * rather than from its last cold start.
 */
const RESULTS_FIRST_FAILED_KEY = "resultsFirstFailedAt";
/** Give up on a result after this long; the payload is logged instead. */
const RESULT_RETRY_WINDOW_MS = 6 * 60 * 60 * 1000;
/**
 * Consecutive alarm wakes that changed nothing. A wedged auto-play would
 * otherwise reschedule `now + 1s` forever; past this many, the alarm stops.
 */
const MAX_STAGNANT_WAKES = 5;
/** How long an emptied table is kept before its storage is dropped. */
const EMPTY_TABLE_TTL_MS = 60 * 60 * 1000;
/**
 * Floor for an alarm whose target time has already passed. `setAlarm` with a
 * past timestamp fires immediately, and because the target is recomputed from
 * an unchanged deadline it fires immediately again — the abandoned-table hot
 * loop. Nudging forward breaks the cycle while still waking promptly.
 */
const MIN_ALARM_DELAY_MS = 1_000;

interface SocketAttachment {
  playerId: string;
  name: string;
}

type RoomStatus = "waiting" | "playing" | "finished" | "abandoned";

export class TableRoom extends DurableObject<Env> {
  /** Protected, not private: the test-only subclass drives these directly. */
  protected state: MiaState | null = null;
  protected timings: Timings = DEFAULT_TIMINGS;
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
  /** Total result-write attempts made by this room, for diagnostics. */
  protected resultWriteAttempts = 0;
  /** How long a result may keep failing before the room gives up on it. */
  protected resultRetryWindowMs = RESULT_RETRY_WINDOW_MS;
  /** Epoch ms of the first failed result write in this outage, if any. */
  private resultsFirstFailedAt: number | null = null;
  /** Guards the one-off "giving up" log. */
  private resultsGaveUpLogged = false;
  /** Set once the retry window has elapsed and the write has been abandoned. */
  private resultsGivenUp = false;
  /** Consecutive alarm wakes that produced no state change. */
  private stagnantWakes = 0;
  /** State fingerprint at the previous wake, for the wedge detector. */
  private lastWakeFingerprint = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // `room` is the only game key, so every game write is atomic; the empty
    // timestamp and the written marker are independent keys that `deleteAll`
    // clears with it.
    ctx.blockConcurrencyWhile(async () => {
      const [stored, emptySince, written, firstFailed] = await Promise.all([
        ctx.storage.get<MiaState>(STATE_KEY),
        ctx.storage.get<number>(EMPTY_SINCE_KEY),
        ctx.storage.get<boolean>(RESULTS_WRITTEN_KEY),
        ctx.storage.get<number>(RESULTS_FIRST_FAILED_KEY),
      ]);
      if (stored && stored.tableId) {
        // A room can hibernate across a deploy, so the state it wakes up with
        // may predate fields the current engine writes.
        this.state = normalizeState(stored);
        // Only the persisted marker proves D1 has the result.
        this.resultsWritten = stored.gameOver !== null && written === true;
      }
      if (typeof emptySince === "number") this.emptySince = emptySince;
      if (typeof firstFailed === "number") this.resultsFirstFailedAt = firstFailed;
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
    // passes the canonical table id through with the upgrade. An upgrade without
    // it is a Worker bug, not a client error: refuse it rather than invent an id,
    // which would otherwise reach the lobby state and the D1 result write as a
    // guessed value. This mirrors the missing-identity refusal above.
    const tableId = request.headers.get("X-Mia-Table-Id");
    if (!tableId) {
      return new Response("Missing table id.", { status: 400 });
    }
    // ...and the table's creator, from the D1 row, so "who starts" never depends
    // on which socket happened to arrive first.
    const hostId = request.headers.get("X-Mia-Host-Id") || null;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hibernation: both the socket and its tag survive eviction.
    this.ctx.acceptWebSocket(server, [playerId]);
    server.serializeAttachment({ playerId, name: playerName } satisfies SocketAttachment);

    await this.handleConnect(server, playerId, playerName, tableName, tableId, hostId);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleConnect(
    socket: WebSocket,
    playerId: string,
    name: string,
    tableName: string,
    tableId: string,
    hostId: string | null,
  ): Promise<void> {
    await this.clearEmptySince();
    // A connection is fresh information: give a room that had stopped re-arming
    // another chance to make progress.
    this.stagnantWakes = 0;
    const state = this.state;

    if (state === null) {
      // No game yet: this is a lobby seat. The roster lives in the DO so a
      // pre-game table keeps its list of who is waiting. A table opened by a
      // rematch also inherits the seats the finished table left for it.
      this.state = this.newLobbyState(playerId, name, tableName, tableId, hostId, await this.readSeedSeats(tableId));
      await this.persistAndBroadcast();
      await this.syncTableRow();
      await this.ensureAlarm();
      return;
    }

    // Clone, change the clone, then persist through `commit` — the rest of the
    // file's rule. Mutating `this.state` first would leave memory and storage
    // disagreeing if the write failed.
    const next = structuredClone(state);
    // A room persisted before `hostId` existed learns it on this connect.
    if (hostId !== null) next.hostId ??= hostId;

    const existing = playerById(next, playerId);
    if (!existing) {
      if (next.round > 0) {
        this.sendTo(playerId, {
          type: "error",
          message: "That game already started, so you are watching. Ask for a new table to play.",
        });
        const view = this.redactedFor(playerId);
        if (view) this.sendTo(playerId, view);
        return;
      }
      if (next.players.length >= MAX_PLAYERS) {
        this.rejectJoin(socket, "table-full", `That table is full (${MAX_PLAYERS} players).`);
        return;
      }
      next.players.push({
        id: playerId,
        name,
        lives: STARTING_LIVES,
        dice: null,
        roundsPlayed: 0,
        eliminated: false,
        eliminationIndex: null,
        record: null,
      });
      next.tableName = tableName;
    } else if (existing.name !== name) {
      existing.name = name;
    }

    // A returning player is a reconnect: they get the current snapshot and
    // nothing about the game changes.
    await this.commit(next);
    await this.syncTableRow();
    await this.ensureAlarm();
  }

  /**
   * Turn a connection away for good. The coded error is sent first — frames are
   * ordered, so the client reads the reason before the close — and then the
   * socket is closed rather than left in `getWebSockets()`, where it would keep
   * receiving the table's broadcasts and inflate every snapshot's `connected`
   * list with a player who has no seat.
   */
  private rejectJoin(socket: WebSocket, code: ErrorCode, message: string): void {
    this.send(socket, { type: "error", code, message });
    try {
      socket.close(1008, message);
    } catch {
      /* already closing; the close handler will still run */
    }
  }

  private newLobbyState(
    playerId: string,
    name: string,
    tableName: string,
    tableId: string,
    hostId: string | null,
    seeded: SeededPlayer[] = [],
  ): MiaState {
    // A rematch hands its new table a roster, but this socket is the authority
    // on who is actually here: the connecting player keeps their current name
    // and is appended if the seeded list does not know them (someone opening a
    // rematch link who was not at the old table).
    const players = seeded.map((seat) => lobbySeat(seat.playerId, seat.playerId === playerId ? name : seat.name));
    if (!seeded.some((seat) => seat.playerId === playerId)) players.push(lobbySeat(playerId, name));
    return {
      tableId,
      tableName,
      // Without the header the first socket is all we have to go on.
      hostId: hostId ?? playerId,
      gameId: "",
      startedAt: null,
      phase: "roundStart",
      round: 0,
      players,
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
      rematchId: null,
    };
  }

  /**
   * The seats a finished table left for this one, if any. Best effort: a D1
   * hiccup here must not stop somebody joining a table, and an empty list is
   * exactly what an ordinary table's first connect looks like.
   *
   * The id comes from the upgrade rather than from `tableId()`: this runs
   * precisely when there is no state yet, so `tableId()` is still "".
   */
  private async readSeedSeats(tableId: string): Promise<SeededPlayer[]> {
    if (tableId === "") return [];
    try {
      return await readTableSeats(this.env, tableId);
    } catch (error) {
      console.error("failed to read the rematch seats", describe(error));
      return [];
    }
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
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    try {
      ws.close(code === 1000 ? 1000 : 1001, reason);
    } catch {
      /* already closing */
    }
    await this.afterDisconnect(ws, attachment?.playerId ?? null);
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    await this.afterDisconnect(ws, attachment?.playerId ?? null);
  }

  /**
   * One socket went away. Before the game starts that frees the seat, so a host
   * who closes their tab cannot leave a ghost blocking everybody else. Once the
   * game is under way the seat stays — auto-play covers a dropped phone — and so
   * does a player who still has another socket open.
   */
  private async afterDisconnect(closing: WebSocket | null, playerId: string | null): Promise<void> {
    let dropped = false;
    if (playerId !== null && !this.hasOtherSocket(playerId, closing)) {
      dropped = await this.removePreGameSeat(playerId);
    }
    // `removePreGameSeat` already broadcast; otherwise the `connected` list in
    // the snapshot still needs refreshing.
    if (!dropped) await this.broadcast();
    await this.ensureAlarm();
  }

  /** True when `playerId` still has a live socket other than the one closing. */
  private hasOtherSocket(playerId: string, closing: WebSocket | null): boolean {
    for (const socket of this.ctx.getWebSockets(playerId)) {
      if (socket !== closing && socket.deserializeAttachment()) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Alarm: turn clock, reveal beat, round beat, empty-table cleanup
  // -------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    const now = Date.now();
    this.noteWake();

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

  /**
   * Count alarm wakes that changed nothing. A wedged auto-play — a phase whose
   * beat is perpetually due because `applyAction` keeps rejecting the move —
   * would otherwise reschedule `now + 1s` forever and never reach the reaper.
   */
  private noteWake(): void {
    const state = this.state;
    const fingerprint = state === null ? "none" : [state.logSeq, state.round, state.phase].join(":");
    if (fingerprint === this.lastWakeFingerprint) {
      this.stagnantWakes += 1;
    } else {
      this.stagnantWakes = 0;
      this.lastWakeFingerprint = fingerprint;
    }
  }

  /** True while a finished game's result still has not reached D1. */
  private hasPendingResults(): boolean {
    return (
      this.state !== null && this.state.gameOver !== null && !this.resultsWritten && !this.resultsGivenUp
    );
  }

  /**
   * Stop trying, loudly. The payload goes to the logs so a human can recover it
   * by hand, the retry stops being armed, and the room becomes collectable —
   * a durably broken D1 must not keep a finished table alive forever.
   */
  private async giveUpOnResults(state: MiaState, now: number): Promise<void> {
    const started = this.resultsFirstFailedAt ?? now;
    this.resultsGivenUp = true;
    this.resultsRetryAt = null;
    if (!this.resultsGaveUpLogged) {
      this.resultsGaveUpLogged = true;
      console.error(
        `giving up on game ${state.gameId} after ${Math.round((now - started) / 1000)}s of failed writes; payload follows`,
        JSON.stringify({ tableId: state.tableId, gameOver: state.gameOver, players: finalStandings(state) }),
      );
    }
    await this.ctx.storage.deleteAlarm();
  }

  /** Retry the D1 result write once its backoff is due, then reschedule. */
  private async retryResults(now: number): Promise<void> {
    if (this.resultsRetryAt !== null && this.resultsRetryAt > now) {
      await this.scheduleAlarm(this.resultsRetryAt);
      return;
    }
    const state = this.state;
    if (state !== null) {
      if (this.resultsFirstFailedAt !== null && now - this.resultsFirstFailedAt > this.resultRetryWindowMs) {
        await this.giveUpOnResults(state, now);
      } else {
        await this.writeResults(state);
      }
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
      // Mark the directory row before dropping the room, so the lobby stops
      // advertising a table that no longer exists rather than waiting for the
      // 30-minute staleness filter. Only an unfinished room: a completed game's
      // row must stay "finished". Best effort — the row is not the state.
      if (this.state !== null && this.state.gameOver === null) await this.syncTableRow("abandoned");
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
      case "ping": {
        // Reply to the caller only. A full broadcast here let one client
        // amplify a single message into a snapshot for every socket at the
        // table, which is the cheapest possible abuse of a demo with no rate
        // limiting.
        const view = this.redactedFor(playerId);
        if (view) this.sendTo(playerId, view);
        return;
      }
      case "start":
        await this.handleStart(playerId);
        return;
      case "roll":
        await this.applyAndContinue(playerId, { type: "roll", playerId }, message.logSeq);
        return;
      case "believe":
        await this.applyAndContinue(playerId, { type: "believe", playerId }, message.logSeq);
        return;
      case "announce": {
        if (typeof message.value !== "number" || !Number.isInteger(message.value)) {
          await this.reportError(playerId, "Malformed announcement.");
          return;
        }
        await this.applyAndContinue(playerId, { type: "announce", playerId, value: message.value }, message.logSeq);
        return;
      }
      case "doubt":
        await this.applyAndContinue(playerId, { type: "doubt", playerId }, message.logSeq);
        return;
      case "leave":
        await this.handleLeave(playerId);
        return;
      case "rematch":
        await this.handleRematch(playerId);
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
    if (state.players.length < MIN_PLAYERS) {
      await this.reportError(playerId, `You need at least ${MIN_PLAYERS} players to start.`);
      return;
    }
    // The table's creator starts. Arrival order is not authority: the D1 row
    // names the creator and the Worker forwards that id on every upgrade. Only
    // once the creator is not connected does anyone seated get to start — the
    // abandoned-host case B5 fixed, kept.
    const hostId = state.hostId ?? state.players[0]?.id ?? null;
    if (hostId !== null && hostId !== playerId && this.isConnected(hostId)) {
      const hostName = playerById(state, hostId)?.name;
      await this.reportError(
        playerId,
        hostName ? `Only ${hostName} can start this table.` : "Only the table's creator can start this one.",
      );
      return;
    }

    const seats: Seat[] = state.players.map((player) => ({ id: player.id, name: player.name }));
    if (this.tableId() === "") {
      await this.reportError(playerId, "This table has no id, so its result could not be recorded.");
      return;
    }
    const next = createGameState(this.tableId(), state.tableName, seats, Date.now(), this.timings);
    next.hostId = state.hostId ?? hostId;
    await this.resetResultsWrite();
    await this.commit(next);
    // The rematch handoff is over: this table's roster lives in its own room now.
    await this.clearSeedSeats();
    await this.syncTableRow("playing");
    await this.ensureAlarm();
  }

  /** Drop the seats a rematch handed this table. Best effort, like the syncs. */
  private async clearSeedSeats(): Promise<void> {
    const id = this.tableId();
    if (id === "") return;
    try {
      await clearTableSeats(this.env, id);
    } catch (error) {
      console.error("failed to clear the rematch seats", describe(error));
    }
  }

  /**
   * Open the table a finished game's rematch plays at.
   *
   * A table is single-use by design, so this creates a *new* one — same name,
   * same creator, same roster — and the link travels to every socket inside the
   * snapshot (`state.rematchId`) rather than in a message of its own. That is
   * what reaches a client whose socket was down when the press happened: the
   * snapshot it reconnects to already carries the link, so nobody has to have
   * been watching at the right moment.
   *
   * Anybody seated may press it, eliminated players included; a spectator who
   * opened the link after the game started is not at the table and may not.
   * There is no host rule here, unlike `handleStart`: a rematch is the whole
   * table's move, not a decision about who is allowed to begin.
   *
   * Two presses in the same instant cannot produce two tables, and that is a
   * property of the id rather than of a lock: it is derived from the finished
   * game (`rematchTableId`), so both presses name the same table, and both
   * inserts are `ON CONFLICT DO NOTHING`. The work may happen twice; the row
   * cannot.
   */
  private async handleRematch(playerId: string): Promise<void> {
    const state = this.state;
    if (state === null || state.gameOver === null) {
      await this.reportError(playerId, "This table's game is not over yet.");
      return;
    }
    if (!playerById(state, playerId)) {
      await this.reportError(playerId, "Only players at this table can open a rematch.");
      return;
    }
    // Already open: every snapshot carries the link, and this one just arrived.
    if (state.rematchId !== null) return;

    const id = rematchTableId(state.gameId);
    const seats: SeededPlayer[] = state.players.map((player) => ({ playerId: player.id, name: player.name }));
    if (this.tableId() === "") {
      await this.reportError(playerId, "This table has no id, so it cannot open a rematch.");
      return;
    }
    try {
      await createRematchTable(this.env, {
        id,
        name: state.tableName,
        hostId: state.hostId ?? playerId,
        maxPlayers: MAX_PLAYERS,
        players: seats,
        now: Date.now(),
      });
    } catch (error) {
      // Nothing half-open: the new table's row and its seats go in one batch, so
      // a failure leaves no table to join and the press can simply be repeated.
      console.error(`failed to open rematch table ${id}`, describe(error));
      await this.reportError(playerId, "Could not open the rematch table. Try again.");
      return;
    }
    const next = structuredClone(this.state ?? state);
    next.rematchId = id;
    // The broadcast reaches every open socket, the presser included.
    await this.commit(next);
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
    await this.removePreGameSeat(playerId);
  }

  /**
   * Drop a seat from a table that has not started. Returns true when a seat was
   * actually removed. Mid-game the roster is frozen: the turn clock auto-plays
   * for a dropped phone instead, and the D1 `tables` row keeps counting them.
   */
  private async removePreGameSeat(playerId: string): Promise<boolean> {
    const state = this.state;
    if (state === null || state.round > 0) return false;
    const index = state.players.findIndex((player) => player.id === playerId);
    if (index === -1) return false;
    const next = structuredClone(state);
    next.players.splice(index, 1);
    await this.commit(next);
    await this.syncTableRow();
    return true;
  }

  /** Apply a player action, then hand the turn on (auto-playing dead seats). */
  private async applyAndContinue(playerId: string, action: MiaAction, stamp?: number): Promise<void> {
    const state = this.state;
    if (state === null) {
      await this.reportError(playerId, "No game is running.");
      return;
    }
    // A move decided against an older snapshot is a stale intent: it was queued
    // during a disconnect and replayed after the table moved on. Refuse it
    // rather than let a previous round's announcement land in this one.
    if (stamp !== undefined && stamp !== state.logSeq) {
      await this.reportError(playerId, "That move is stale: the table has already moved on.");
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

  /**
   * The canonical table id, or "" when there is no state at all. `fetch`
   * refuses an upgrade that carries no `X-Mia-Table-Id`, so a live state always
   * has one; the callers' `""` checks are a backstop against a state that can
   * no longer be built, not the mechanism that rejects a guessed id.
   */
  private tableId(): string {
    return this.state?.tableId ?? "";
  }

  /** Persist first, then swap into memory, then tell everyone. */
  protected async commit(next: MiaState): Promise<void> {
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
    if (this.tableId() === "") {
      // Never write a result against a guessed table id; say so instead.
      console.error(`refusing to record game ${state.gameId}: the room has no table id`);
      return;
    }
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
      // A test-only subclass overrides these to simulate a flaky D1; production
      // always says no. Nothing test-shaped is checked on a real write.
      if (this.shouldFailResultWrite()) throw new Error("stubbed D1 failure");
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
      if (this.shouldFailFinishedSync()) throw new Error("stubbed lobby sync failure");
      // Unlike the routine lobby syncs, a failure here must keep the retry
      // alive: otherwise the lobby keeps advertising a finished table.
      await this.syncTableRow("finished", true);
      // The marker goes down only after D1 has actually taken the rows.
      await this.ctx.storage.put(RESULTS_WRITTEN_KEY, true);
      this.resultsWritten = true;
      this.resultsAttempts = 0;
      this.resultsRetryAt = null;
      this.resultsFirstFailedAt = null;
      this.resultsGivenUp = false;
      await this.ctx.storage.delete(RESULTS_FIRST_FAILED_KEY);
    } catch (error) {
      const now = Date.now();
      if (this.resultsFirstFailedAt === null) {
        this.resultsFirstFailedAt = now;
        await this.ctx.storage.put(RESULTS_FIRST_FAILED_KEY, now);
      }
      this.resultsAttempts += 1;
      // The first failure starts the window; past it the room gives up rather
      // than keeping a finished table alive forever.
      if (now - this.resultsFirstFailedAt > this.resultRetryWindowMs) {
        await this.giveUpOnResults(state, now);
        return;
      }
      const backoff = resultWriteBackoffMs(this.resultsAttempts);
      this.resultsRetryAt = now + backoff;
      console.error(
        `failed to record game result (attempt ${this.resultsAttempts}); retrying in ${backoff}ms`,
        describe(error),
      );
      // Arm the retry here as well as through `ensureAlarm`: a caller that
      // returns immediately on game over never reaches `ensureAlarm`.
      await this.scheduleAlarm(this.resultsRetryAt);
    }
  }

  /** Overridden by the test-only subclass to simulate a D1 failure. */
  protected shouldFailResultWrite(): boolean {
    return false;
  }

  /** Overridden by the test-only subclass to fail after the rows have landed. */
  protected shouldFailFinishedSync(): boolean {
    return false;
  }

  /** Clear the result-write bookkeeping, e.g. when a fresh game starts. */
  private async resetResultsWrite(): Promise<void> {
    this.resultsWritten = false;
    this.resultsAttempts = 0;
    this.resultsRetryAt = null;
    this.resultWriteAttempts = 0;
    this.resultsFirstFailedAt = null;
    this.resultsGaveUpLogged = false;
    this.resultsGivenUp = false;
    await this.ctx.storage.delete(RESULTS_WRITTEN_KEY);
    await this.ctx.storage.delete(RESULTS_FIRST_FAILED_KEY);
  }

  /** Keep the D1 lobby directory in step with this table. */
  private async syncTableRow(status?: RoomStatus, throwOnError = false): Promise<void> {
    const state = this.state;
    const id = this.tableId();
    if (state === null || id === "") return;
    try {
      await updateTable(this.env, id, {
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
      state: buildView(state, viewerId),
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
        state: buildView(state, attachment.playerId),
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
        if (this.stagnantWakes >= MAX_STAGNANT_WAKES) {
          // Several wakes have changed nothing: the beat is wedged. With nobody
          // connected, let the reaper have the room; otherwise stop re-arming
          // and say so, rather than billing a 1 Hz loop forever.
          if (this.ctx.getWebSockets().length === 0) {
            await this.maybeReapEmptyRoom(now);
            return;
          }
          console.error(
            `alarm stopped re-arming: ${this.stagnantWakes} wakes with no progress at round ${state.round} phase ${state.phase}`,
          );
          await this.ctx.storage.deleteAlarm();
          return;
        }
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
 * The id of the table a rematch opens. Derived from the finished game instead of
 * minted: two players can press Rematch at the same moment, and both presses
 * have to name the same table for `ON CONFLICT DO NOTHING` to make the second a
 * no-op. The suffix keeps it out of the uuid shape a table created through the
 * lobby has, so the two can never collide.
 */
export function rematchTableId(gameId: string): string {
  return `${gameId}-r`;
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
 * A pre-game seat. There is no record yet — nothing has been played — and the
 * fields the engine fills in at `createGameState` are the neutral values.
 */
function lobbySeat(id: string, name: string): MiaPlayer {
  return {
    id,
    name,
    lives: STARTING_LIVES,
    dice: null,
    roundsPlayed: 0,
    eliminated: false,
    eliminationIndex: null,
    record: null,
  };
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
