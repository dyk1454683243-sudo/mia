/**
 * Shared plumbing for the protocol-level harnesses: `e2e.ts` (which plays whole
 * games and asserts) and `bots.ts` (which fills the non-human seats).
 *
 * Node runs this directly by stripping the types, so imports carry explicit
 * `.ts` extensions and nothing here may use a Cloudflare-only global.
 */
import {
  legalMoves,
  MIA,
  minimumAnnouncement,
  rollValue,
  type MiaAction,
  type MiaState,
} from "../src/shared/mia.ts";

export const BASE = process.env.MIA_BASE ?? "http://127.0.0.1:8787";

/** How long a client waits for the snapshot it is waiting for. */
export const SNAPSHOT_TIMEOUT_MS = 20_000;

export interface Player {
  label: string;
  id: string;
  name: string;
  cookie: string;
}

/** Mint a brand-new player by fetching the lobby, exactly like a fresh browser. */
export async function createPlayer(label: string): Promise<Player> {
  const response = await fetch(`${BASE}/api/me`, { redirect: "manual" });
  const body = (await response.json()) as { id: string; name: string };
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = /mia_pid=([^;]+)/.exec(setCookie);
  if (!match) throw new Error(`no session cookie for ${label}`);
  return { label, id: body.id, name: body.name, cookie: `mia_pid=${match[1]}` };
}

export async function api(
  path: string,
  init: RequestInit & { player?: Player; raw?: boolean } = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
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

/**
 * One player's WebSocket, with the snapshot bookkeeping a driver needs. Node's
 * global WebSocket is used directly because it can carry the session cookie as
 * a header, which a browser cannot.
 */
export class Client {
  readonly player: Player;
  private socket: WebSocket | null = null;
  private states: MiaState[] = [];
  private connected: string[] = [];
  private errors: string[] = [];
  /** Increments for every state snapshot, so waiters can demand something newer. */
  private seq = 0;
  private waiters: { after: number; predicate: () => boolean; resolve: () => void; reject: (error: Error) => void }[] =
    [];

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
        // A refusal is always recorded *and* fails anything waiting on the
        // action it refused, so a rejection can never masquerade as a timeout.
        this.errors.push(message.message);
        const pending = this.waiters.splice(0);
        for (const waiter of pending) waiter.reject(new Error(`${this.player.label}: server said "${message.message}"`));
        return;
      }
      this.states.push(message.state);
      this.connected = message.connected;
      this.seq += 1;
      for (let index = this.waiters.length - 1; index >= 0; index--) {
        const waiter = this.waiters[index]!;
        // `after` is the seq at registration; only snapshots past it count.
        if (waiter.after >= this.seq) continue;
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

  get sequence(): number {
    return this.seq;
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

  /** Resolve as soon as the predicate holds, including on the snapshot already on screen. */
  waitFor(predicate: (state: MiaState) => boolean, timeoutMs = SNAPSHOT_TIMEOUT_MS): Promise<void> {
    if (this.state && predicate(this.state)) return Promise.resolve();
    return this.await((state) => predicate(state), timeoutMs);
  }

  /**
   * Resolve only on a snapshot that arrives after this call. Every accepted
   * action broadcasts, so this is how a driver waits for the server's answer
   * rather than for a state it has already reacted to.
   */
  waitNext(predicate: (state: MiaState) => boolean = () => true, timeoutMs = SNAPSHOT_TIMEOUT_MS): Promise<void> {
    return this.await(predicate, timeoutMs, this.seq);
  }

  private await(predicate: (state: MiaState) => boolean, timeoutMs: number, after = -1): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = {
        after,
        predicate: () => this.state !== null && predicate(this.state),
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.waiters.push(waiter);
      timer = setTimeout(() => {
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

/** Seeded PRNG, so a failing run replays exactly. Override with MIA_SEED. */
export function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A real strategy rather than the server's idle fallback. The fallback always
 * announces the minimum legal value, so every round climbs the whole ladder to
 * Mia before anyone can doubt — ~40 turns per round, and the standing
 * announcement is a bluff virtually every time, so a failed doubt is never
 * exercised. This announces the truth whenever the truth is legal and doubts
 * opportunistically, which reaches both verdicts and ends rounds fast.
 */
export function chooseAction(state: MiaState, playerId: string, random: () => number): MiaAction | null {
  const moves = legalMoves(state, playerId);
  const standing = state.lastAnnouncement?.value ?? null;

  if (state.phase === "announcing") {
    // The cup holder is the one viewer allowed to see these dice.
    const dice = state.players.find((player) => player.id === playerId)?.dice ?? null;
    const actual = dice ? rollValue(dice[0], dice[1]) : null;
    if (actual !== null && moves.announcements.includes(actual)) {
      return { type: "announce", playerId, value: actual };
    }
    const minimum = minimumAnnouncement(standing);
    return minimum === null ? null : { type: "announce", playerId, value: minimum };
  }

  if (state.phase !== "deciding") return null;
  // Nothing beats Mia, and nothing beats a standing announcement with no room
  // above it: doubting is the only move left.
  if (moves.canDoubt && (standing === MIA || !moves.canAnnounce)) {
    return { type: "doubt", playerId };
  }
  if (moves.canDoubt && random() < 0.3) return { type: "doubt", playerId };
  if (moves.canRoll && standing === null) return { type: "roll", playerId };
  if (moves.canBelieve) return { type: "believe", playerId };
  if (moves.canDoubt) return { type: "doubt", playerId };
  return null;
}

/** Resolve as soon as any client receives a new snapshot, or after `timeoutMs`. */
export async function nextSnapshot(clients: Client[], timeoutMs: number): Promise<void> {
  await Promise.race(
    clients.map((client) => client.waitNext(() => true, timeoutMs).catch(() => undefined)),
  );
}
