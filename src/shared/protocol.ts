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

export type ClientMessage =
  | { type: "start" }
  | { type: "roll" }
  | { type: "announce"; value: number }
  | { type: "believe" }
  | { type: "doubt" }
  | { type: "leave" }
  | { type: "ping" };

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

export interface ErrorMessage {
  type: "error";
  message: string;
}

export type ServerMessage = StateView | ErrorMessage;

/** Narrowing helper for tests and clients. */
export function isStateMessage(message: ServerMessage): message is StateView {
  return message.type === "state";
}

export type { MiaAction, MiaState };
