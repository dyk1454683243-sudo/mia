/**
 * Wire contract shared by the Worker, the Durable Object and the browser.
 * Both sides import this module so a protocol change breaks the typecheck
 * rather than a running game.
 */
import type { MiaAction, MiaState } from "./mia";

export interface PlayerIdentity {
  id: string;
  name: string;
}

export interface TableSummary {
  id: string;
  name: string;
  hostId: string;
  hostName: string;
  status: "waiting" | "playing" | "finished" | "abandoned";
  playerCount: number;
  maxPlayers: number;
  createdAt: number;
  updatedAt: number;
}

export interface HistoryEntry {
  id: string;
  tableId: string;
  tableName: string;
  startedAt: number;
  finishedAt: number;
  winnerId: string;
  winnerName: string;
  players: { playerId: string; name: string; place: number; livesLeft: number; roundsPlayed: number }[];
}

export interface ApiError {
  error: string;
}

export interface CreateTableRequest {
  name?: string;
}

export interface CreateTableResponse {
  id: string;
  name: string;
}

export interface RenameRequest {
  name?: string;
}

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

/**
 * Every client message carries the `logSeq` of the snapshot it was decided
 * against. A message queued while the socket was down and replayed after a
 * reconnect is stale by construction — the table may be several turns on — so
 * the server refuses a stamp that no longer matches instead of applying an
 * intent from a previous round. Optional: an unstamped move is accepted, which
 * keeps bare protocol clients and the older harness working.
 */
export interface MoveStamp {
  logSeq?: number;
}

export type ClientMessage =
  | ({ type: "start" } & MoveStamp)
  | ({ type: "roll" } & MoveStamp)
  | ({ type: "announce"; value: number } & MoveStamp)
  | ({ type: "believe" } & MoveStamp)
  | ({ type: "doubt" } & MoveStamp)
  | ({ type: "leave" } & MoveStamp)
  | ({ type: "ping" } & MoveStamp);

export interface StateView {
  type: "state";
  /** Viewer-specific snapshot: other players' hidden dice are stripped. */
  state: MiaState;
  /** This viewer's id, so the client does not have to guess. */
  you: string;
  /** Epoch ms after which the current phase auto-plays. */
  deadlineAt: number | null;
  /** Server time when the snapshot was built, for clock-drift correction. */
  serverTime: number;
  /** Live connection state, by player id. */
  connected: string[];
}

/**
 * The errors a client must act on rather than merely toast. A bare error is
 * informational and may be transient; a coded one changes what the page shows.
 */
export type ErrorCode = "table-full";

export interface ErrorMessage {
  type: "error";
  /**
   * Optional machine-readable kind. `table-full` is terminal: the rejected
   * client stops reconnecting and offers the lobby instead of "Connecting…".
   */
  code?: ErrorCode;
  message: string;
}

export type ServerMessage = StateView | ErrorMessage;

/** Narrowing helper for tests and clients. */
export function isStateMessage(message: ServerMessage): message is StateView {
  return message.type === "state";
}

export type { MiaAction, MiaState };
