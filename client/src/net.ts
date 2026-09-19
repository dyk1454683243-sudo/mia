/**
 * HTTP and WebSocket plumbing for the browser. No framework: every render is a
 * pure function of the latest server snapshot.
 */
import type { ClientMessage, ErrorCode, HistoryEntry, ServerMessage, StateView, TableSummary } from "../../src/shared/protocol";

export interface Me {
  id: string;
  name: string;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  me: () => request<Me>("/api/me"),
  rename: (name: string) => request<Me>("/api/me", { method: "PATCH", body: JSON.stringify({ name }) }),
  tables: () => request<{ tables: TableSummary[] }>("/api/tables").then((r) => r.tables ?? []),
  table: (id: string) => request<TableSummary>(`/api/tables/${encodeURIComponent(id)}`),
  createTable: (name: string) =>
    request<{ id: string; name: string }>("/api/tables", { method: "POST", body: JSON.stringify({ name }) }),
  history: (limit = 8) => request<{ games: HistoryEntry[] }>(`/api/history?limit=${limit}`).then((r) => r.games ?? []),
};

export interface SocketHandlers {
  onState: (view: StateView) => void;
  onError: (message: string, code?: ErrorCode) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

/**
 * A reconnecting table socket. A dropped phone or a backgrounded tab simply
 * reconnects and receives the current snapshot.
 */
export class TableSocket {
  private socket: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private timer: number | null = null;
  private queue: ClientMessage[] = [];

  constructor(
    private readonly tableId: string,
    private readonly handlers: SocketHandlers,
    /**
     * Forward the page's `?watch=1` onto the upgrade. The Worker is what
     * canonicalizes that query into `X-Mia-Spectator`; this flag only asks.
     */
    private readonly watch = false,
  ) {}

  connect(): void {
    if (this.closed || this.socket) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const query = this.watch ? "?watch=1" : "";
    const url = `${protocol}//${location.host}/api/tables/${encodeURIComponent(this.tableId)}/ws${query}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.attempt = 0;
      this.handlers.onOpen?.();
      for (const message of this.queue.splice(0)) this.send(message);
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      if (parsed.type === "state") this.handlers.onState(parsed);
      else if (parsed.type === "error") this.handlers.onError(parsed.message, parsed.code);
    });

    const finish = () => {
      this.socket = null;
      this.handlers.onClose?.();
      if (this.closed) return;
      this.attempt += 1;
      const delay = Math.min(500 * 2 ** Math.min(this.attempt, 5), 8_000);
      this.timer = window.setTimeout(() => this.connect(), delay + Math.random() * 250);
    };
    socket.addEventListener("close", finish);
    socket.addEventListener("error", () => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    });
  }

  send(message: ClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      // Queue the intent; a reconnect replays it once.
      if (this.queue.length < 8) this.queue.push(message);
      this.connect();
      return;
    }
    socket.send(JSON.stringify(message));
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.socket?.close(1000, "client navigating away");
    this.socket = null;
  }
}

// Escaping lives in `src/shared` because the showdown's verdict sentence is
// built there and unit-tested under plain Node; re-exported here so the pages
// keep importing it from `./net`.
export { escapeHtml } from "../../src/shared/html";

/** Coarse relative timestamp, e.g. "4m ago". */
export function relativeTime(at: number): string {
  const diff = Date.now() - at;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
