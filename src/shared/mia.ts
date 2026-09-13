/**
 * Mia — pure rules engine.
 *
 * No Cloudflare imports, no I/O, no clock reads: every function here is a pure
 * transform of state. The Durable Object is a thin shell around this module, and
 * the same code is unit-testable in plain vitest.
 */

// ---------------------------------------------------------------------------
// Dice and ranking
// ---------------------------------------------------------------------------

export type Die = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Ranking, highest to lowest. `21` is Mia: the highest roll and unbeatable.
 * Doubles outrank every mixed roll. Hardcoded on purpose — computing this order
 * is exactly the kind of thing that silently goes wrong.
 */
export const RANKING: readonly number[] = [
  21, 66, 55, 44, 33, 22, 11, 65, 64, 63, 62, 61, 54, 53, 52, 51, 43, 42, 41,
  32, 31,
];

/** The one unbeatable roll. */
export const MIA = 21;

/** Every legal announcement, highest first. */
export const ALL_VALUES: readonly number[] = RANKING;

const RANK_INDEX = new Map<number, number>(RANKING.map((v, i) => [v, i]));

/** True if `value` is a roll that exists in the ranking table. */
export function isRankedValue(value: number): boolean {
  return RANK_INDEX.has(value);
}

/** True if `a` outranks `b`. Equal values do not outrank each other. */
export function outranks(a: number, b: number): boolean {
  const ia = RANK_INDEX.get(a);
  const ib = RANK_INDEX.get(b);
  if (ia === undefined || ib === undefined) return false;
  return ia < ib;
}

/** Value of a pair of dice: higher die × 10 + lower die. */
export function rollValue(hi: Die, lo: Die): number {
  return Math.max(hi, lo) * 10 + Math.min(hi, lo);
}

/** Roll two dice with the platform CSPRNG. */
export function rollDice(): [Die, Die] {
  return [randomDie(), randomDie()];
}

function randomDie(): Die {
  const buf = new Uint8Array(1);
  // Reject the biased tail (256 is not a multiple of 6).
  for (;;) {
    crypto.getRandomValues(buf);
    const value = buf[0]!;
    if (value < 252) return ((value % 6) + 1) as Die;
  }
}

/**
 * Every announcement strictly higher than `standing`.
 * With no standing announcement every value is available.
 */
export function legalAnnouncements(standing: number | null): number[] {
  if (standing === null) return [...RANKING];
  return RANKING.filter((value) => outranks(value, standing));
}
/** True if the ranking string labels the value as a double. */
export function isDouble(value: number): boolean {
  const hi = Math.floor(value / 10);
  const lo = value % 10;
  return hi === lo;
}

/** Pretty label, e.g. `53` -> `5·3`, `11` -> `1·1`. */
export function formatValue(value: number): string {
  const hi = Math.floor(value / 10);
  const lo = value % 10;
  return `${hi}·${lo}`;
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

export const STARTING_LIVES = 6;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

export type Phase =
  /** A round has been seeded; the starter holds the cup, nobody has announced. */
  | "roundStart"
  /** The active player must announce a value or (if dice are on the table) doubt. */
  | "announcing"
  /** The active player must believe or doubt the standing announcement. */
  | "deciding"
  /** A doubt was called; the previous player's dice are face up. */
  | "revealing"
  /** Somebody has 0 lives left and there is a winner. */
  | "finished";

export interface MiaPlayer {
  id: string;
  name: string;
  lives: number;
  /** Dice currently in front of this player, hidden until revealed. */
  dice: [Die, Die] | null;
  roundsPlayed: number;
  eliminated: boolean;
}

export interface Announcement {
  playerId: string;
  playerName: string;
  value: number;
  round: number;
}

export interface LossEvent {
  playerId: string;
  /** 1 or 2 — Mia called and Mia rolled costs the doubter double. */
  lives: number;
  reason: string;
}

export interface DoubtReveal {
  doubterId: string;
  doubterName: string;
  announcerId: string;
  announcerName: string;
  announced: number;
  actual: number;
  /** `announcer` lost the life, `doubter` lost it, or the game is over. */
  verdict: "announcer" | "doubter";
  livesLost: number;
  penaltyApplied: "double-mia" | "single";
}

export interface MiaEvent {
  id: number;
  at: number;
  kind:
    | "start"
    | "roll"
    | "announce"
    | "believe"
    | "doubt"
    | "reveal"
    | "life"
    | "eliminated"
    | "round"
    | "gameover"
    | "left";
  text: string;
  playerId?: string;
  value?: number;
  actual?: number;
  lives?: number;
}

export interface GameOver {
  winnerId: string;
  winnerName: string;
  finishedAt: number;
}

export interface MiaState {
  tableId: string;
  tableName: string;
  gameId: string;
  startedAt: number | null;
  phase: Phase;
  round: number;
  players: MiaPlayer[];
  turnPlayerId: string | null;
  turnStartedAt: number | null;
  /** Absolute epoch ms at which the current phase's clock expires. */
  deadlineAt: number | null;
  /** Whose dice are face up on the table (the cup holder). */
  diceOwnerId: string | null;
  lastAnnouncement: Announcement | null;
  pendingDoubt: DoubtReveal | null;
  lastReveal: DoubtReveal | null;
  lastLoss: LossEvent | null;
  /** Whoever lost the most recent life, and thus starts the next round. */
  nextStarterId: string | null;
  events: MiaEvent[];
  logSeq: number;
  /** Set once the round is over and the next one has been seeded. */
  roundEndsAt: number | null;
  gameOver: GameOver | null;
}

export interface Seat {
  id: string;
  name: string;
}

export type MiaAction =
  | { type: "roll"; playerId: string }
  | { type: "announce"; playerId: string; value: number }
  | { type: "believe"; playerId: string }
  | { type: "doubt"; playerId: string };

export type MiaErrorCode =
  | "wrong-phase"
  | "not-your-turn"
  | "unknown-player"
  | "not-started"
  | "finished"
  | "illegal-announcement"
  | "unknown-value"
  | "nothing-to-doubt"
  | "not-enough-players"
  | "too-many-players";

export interface MiaError {
  code: MiaErrorCode;
  message: string;
}

export type MiaResult =
  | { ok: true; state: MiaState }
  | { ok: false; error: MiaError };

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export function newGameId(now = Date.now()): string {
  return `${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

export function createGameState(
  tableId: string,
  tableName: string,
  seats: Seat[],
  now = Date.now(),
): MiaState {
  const state: MiaState = {
    tableId,
    tableName,
    gameId: newGameId(now),
    startedAt: now,
    phase: "roundStart",
    round: 0,
    players: seats.map((seat) => ({
      id: seat.id,
      name: seat.name,
      lives: STARTING_LIVES,
      dice: null,
      roundsPlayed: 0,
      eliminated: false,
    })),
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
  pushEvent(state, now, "start", `${tableName} — first to lose all ${STARTING_LIVES} lives is out.`);
  startRound(state, seats[0]?.id ?? null, now);
  return state;
}

/** Find a player by id. */
export function playerById(state: MiaState, id: string): MiaPlayer | undefined {
  return state.players.find((p) => p.id === id);
}

export function alivePlayers(state: MiaState): MiaPlayer[] {
  return state.players.filter((p) => !p.eliminated);
}

function seatIndex(state: MiaState, playerId: string | null): number {
  if (playerId === null) return -1;
  return state.players.findIndex((p) => p.id === playerId);
}

/** Next living player after `playerId`, wrapping. Returns null if none. */
export function nextLivingFrom(state: MiaState, playerId: string | null, includeSelf = false): string | null {
  const n = state.players.length;
  if (n === 0) return null;
  const start = seatIndex(state, playerId);
  const from = start === -1 ? 0 : start;
  for (let step = includeSelf ? 0 : 1; step <= n; step++) {
    const candidate = state.players[(from + step) % n];
    if (candidate && !candidate.eliminated) return candidate.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Turn and round plumbing
// ---------------------------------------------------------------------------

export interface Timings {
  /** 60s decision clock. */
  turnMs: number;
  /** How long the reveal stays on screen before the next round is seeded. */
  revealMs: number;
  /** Beat between seeding a round and arming the starter's clock. */
  roundStartMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  turnMs: 60_000,
  revealMs: 5_000,
  roundStartMs: 2_000,
};

function armTurn(state: MiaState, timings: Timings, now: number): void {
  state.turnStartedAt = now;
  state.deadlineAt = now + timings.turnMs;
}

/** Seed a fresh round with `starterId` holding the cup. */
export function startRound(state: MiaState, starterId: string | null, now = Date.now()): void {
  state.round += 1;
  state.lastAnnouncement = null;
  state.pendingDoubt = null;
  state.lastReveal = null;
  state.lastLoss = null;
  state.diceOwnerId = null;
  state.nextStarterId = null;
  for (const p of state.players) {
    p.dice = null;
    if (!p.eliminated) p.roundsPlayed += 1;
  }
  const starter = starterId ?? alivePlayers(state)[0]?.id ?? null;
  state.turnPlayerId = starter;
  state.phase = "roundStart";
  // The round-start beat also runs on the single alarm.
  state.turnStartedAt = now;
  state.deadlineAt = now + DEFAULT_TIMINGS.roundStartMs;
  state.roundEndsAt = state.deadlineAt;
  const starterPlayer = playerById(state, starter ?? "");
  pushEvent(state, now, "round", `Round ${state.round} — ${starterPlayer?.name ?? "nobody"} takes the cup.`);
}

/** Move from the round-start beat into the starter's decision. */
export function beginRoundPlay(state: MiaState, timings: Timings, now = Date.now()): void {
  if (state.phase !== "roundStart") return;
  state.roundEndsAt = null;
  state.phase = "deciding";
  armTurn(state, timings, now);
}

// ---------------------------------------------------------------------------
// Legal moves
// ---------------------------------------------------------------------------

export interface LegalMoves {
  canRoll: boolean;
  canAnnounce: boolean;
  canBelieve: boolean;
  canDoubt: boolean;
  announcements: number[];
}

export function legalMoves(state: MiaState, playerId: string): LegalMoves {
  const none: LegalMoves = {
    canRoll: false,
    canAnnounce: false,
    canBelieve: false,
    canDoubt: false,
    announcements: [],
  };
  if (state.phase !== "deciding" && state.phase !== "announcing") return none;
  if (state.gameOver) return none;
  const player = playerById(state, playerId);
  if (!player || player.eliminated) return none;
  if (state.turnPlayerId !== playerId) return none;

  const standing = state.lastAnnouncement?.value ?? null;
  const announcements = legalAnnouncements(standing);
  // Doubt needs somebody else's dice to turn over.
  const canDoubt = state.lastAnnouncement !== null && state.diceOwnerId !== null;

  if (state.phase === "deciding") {
    return {
      canRoll: true,
      // A roll is always followed by an announcement, so a roll is only useful
      // when some announcement is actually available.
      canAnnounce: announcements.length > 0,
      canBelieve: state.lastAnnouncement !== null && announcements.length > 0,
      canDoubt,
      announcements,
    };
  }

  // Holding the cup means the roll already happened: core rules say you must
  // announce. Doubting is the *next* player's choice, before they roll.
  return {
    canRoll: false,
    canAnnounce: announcements.length > 0,
    canBelieve: false,
    canDoubt: false,
    announcements,
  };
}

// ---------------------------------------------------------------------------
// Applying actions
// ---------------------------------------------------------------------------

function err(code: MiaErrorCode, message: string): MiaResult {
  return { ok: false, error: { code, message } };
}

function guard(state: MiaState, playerId: string): MiaResult | null {
  if (state.gameOver || state.phase === "finished") {
    return err("finished", "This game is over.");
  }
  const player = playerById(state, playerId);
  if (!player) return err("unknown-player", "You are not at this table.");
  if (player.eliminated) return err("unknown-player", "You are out of the game.");
  if (state.turnPlayerId !== playerId) return err("not-your-turn", "It is not your turn.");
  return null;
}

/**
 * Apply one action. The state passed in is never mutated: the result carries a
 * structural clone with the change applied, so the caller can persist before
 * swapping it into memory.
 */
export function applyAction(
  state: MiaState,
  action: MiaAction,
  timings: Timings = DEFAULT_TIMINGS,
  now = Date.now(),
): MiaResult {
  const clone = cloneState(state);
  switch (action.type) {
    case "roll":
      return applyRoll(clone, action.playerId, timings, now);
    case "announce":
      return applyAnnounce(clone, action.playerId, action.value, timings, now);
    case "believe":
      return applyBelieve(clone, action.playerId, timings, now);
    case "doubt":
      return applyDoubt(clone, action.playerId, timings, now);
    default:
      return err("wrong-phase", "Unknown action.");
  }
}

function applyRoll(state: MiaState, playerId: string, timings: Timings, now: number): MiaResult {
  const blocked = guard(state, playerId);
  if (blocked) return blocked;
  if (state.phase !== "deciding") {
    return err("wrong-phase", "You cannot roll right now.");
  }
  const moves = legalMoves(state, playerId);
  if (!moves.canRoll) return err("wrong-phase", "You cannot roll right now.");

  const player = playerById(state, playerId)!;
  const dice = rollDice();
  player.dice = dice;
  state.diceOwnerId = playerId;
  state.phase = "announcing";
  armTurn(state, timings, now);
  pushEvent(state, now, "roll", `${player.name} rolls in secret.`, { playerId });
  return { ok: true, state };
}

function applyAnnounce(
  state: MiaState,
  playerId: string,
  value: number,
  timings: Timings,
  now: number,
): MiaResult {
  const blocked = guard(state, playerId);
  if (blocked) return blocked;
  // Announcing requires the cup: roll (or believe) first, then commit to a claim.
  if (state.phase !== "announcing" || state.diceOwnerId !== playerId) {
    return err("wrong-phase", "Roll before you announce.");
  }
  if (!isRankedValue(value)) {
    return err("unknown-value", `${value} is not a legal roll.`);
  }
  const standing = state.lastAnnouncement?.value ?? null;
  if (standing !== null && !outranks(value, standing)) {
    return err("illegal-announcement", `${formatValue(value)} is not higher than ${formatValue(standing)}.`);
  }

  const player = playerById(state, playerId)!;
  state.lastAnnouncement = {
    playerId,
    playerName: player.name,
    value,
    round: state.round,
  };
  state.phase = "deciding";
  state.pendingDoubt = null;
  state.lastReveal = null;

  const next = nextLivingFrom(state, playerId);
  state.turnPlayerId = next;
  if (next === null) {
    return err("unknown-player", "There is nobody left to play.");
  }
  armTurn(state, timings, now);
  pushEvent(state, now, "announce", `${player.name} announces ${formatValue(value)}.`, {
    playerId,
    value,
  });
  return { ok: true, state };
}

/** Believe == take the cup, roll blind, and then have to beat what stands. */
function applyBelieve(state: MiaState, playerId: string, timings: Timings, now: number): MiaResult {
  const blocked = guard(state, playerId);
  if (blocked) return blocked;
  if (state.phase !== "deciding") {
    return err("wrong-phase", "You cannot believe right now.");
  }
  if (state.lastAnnouncement === null) {
    return err("wrong-phase", "There is nothing to believe yet — you have to roll.");
  }
  const moves = legalMoves(state, playerId);
  if (!moves.canBelieve) {
    return err("illegal-announcement", "Nothing outranks the standing announcement. You must doubt.");
  }

  const player = playerById(state, playerId)!;
  const dice = rollDice();
  player.dice = dice;
  state.diceOwnerId = playerId;
  state.phase = "announcing";
  armTurn(state, timings, now);
  pushEvent(state, now, "believe", `${player.name} believes and takes the cup.`, { playerId });
  return { ok: true, state };
}

function applyDoubt(state: MiaState, playerId: string, timings: Timings, now: number): MiaResult {
  const blocked = guard(state, playerId);
  if (blocked) return blocked;
  // Doubting is a decision made in place of picking up the cup: the doubter has
  // not rolled, and the previous player's dice are still on the table.
  if (state.phase !== "deciding") {
    return err("wrong-phase", "You cannot doubt right now.");
  }
  const announcement = state.lastAnnouncement;
  const ownerId = state.diceOwnerId;
  if (announcement === null || ownerId === null) {
    return err("nothing-to-doubt", "There is no announcement to doubt yet.");
  }
  const owner = playerById(state, ownerId);
  if (!owner || !owner.dice) {
    return err("nothing-to-doubt", "There are no dice on the table.");
  }
  const doubter = playerById(state, playerId)!;
  const actual = rollValue(owner.dice[0], owner.dice[1]);
  const announced = announcement.value;

  // Rank comparison, not arithmetic: a double outranks every higher face value,
  // so 66 beats a claimed 65. Equality counts as a good announcement — the
  // announcer may name exactly what they rolled.
  const bluffCaught = !outranks(actual, announced) && actual !== announced;
  const isMiaTrap = announced === MIA && actual === MIA;
  const livesLost = isMiaTrap ? 2 : 1;
  const loserId = bluffCaught ? owner.id : doubter.id;
  const loser = playerById(state, loserId)!;
  loser.lives = Math.max(0, loser.lives - livesLost);

  const reveal: DoubtReveal = {
    doubterId: doubter.id,
    doubterName: doubter.name,
    announcerId: owner.id,
    announcerName: owner.name,
    announced,
    actual,
    verdict: bluffCaught ? "announcer" : "doubter",
    livesLost,
    penaltyApplied: isMiaTrap ? "double-mia" : "single",
  };

  state.pendingDoubt = reveal;
  state.lastReveal = reveal;
  state.lastLoss = {
    playerId: loser.id,
    lives: livesLost,
    reason: isMiaTrap
      ? `${doubter.name} doubted a real Mia.`
      : bluffCaught
        ? `${owner.name} announced ${formatValue(announced)} on a ${formatValue(actual)}.`
        : `${owner.name} really had ${formatValue(actual)}.`,
  };
  state.nextStarterId = loser.id;
  state.phase = "revealing";
  state.turnPlayerId = null;
  state.turnStartedAt = now;
  state.deadlineAt = now + timings.revealMs;

  pushEvent(state, now, "doubt", `${doubter.name} doubts ${owner.name}.`, { playerId: doubter.id });
  pushEvent(
    state,
    now,
    "reveal",
    `${owner.name} had ${formatValue(actual)} and announced ${formatValue(announced)}.`,
    { playerId: owner.id, actual, value: announced },
  );
  pushEvent(
    state,
    now,
    "life",
    `${loser.name} loses ${livesLost} ${livesLost === 1 ? "life" : "lives"} (${loser.lives} left).`,
    { playerId: loser.id, lives: livesLost },
  );

  resolveEliminations(state, now);
  return { ok: true, state };
}

function resolveEliminations(state: MiaState, now: number): void {
  for (const player of state.players) {
    if (!player.eliminated && player.lives <= 0) {
      player.eliminated = true;
      pushEvent(state, now, "eliminated", `${player.name} is out of the game.`, { playerId: player.id });
    }
  }
  const alive = alivePlayers(state);
  if (alive.length <= 1) {
    const winner = alive[0];
    if (winner) {
      state.gameOver = { winnerId: winner.id, winnerName: winner.name, finishedAt: now };
      state.phase = "finished";
      state.turnPlayerId = null;
      state.deadlineAt = null;
      pushEvent(state, now, "gameover", `${winner.name} wins.`, { playerId: winner.id });
    }
  }
}

/** Close out the reveal and seed the next round (or finish the game). */
export function resolveReveal(state: MiaState, timings: Timings, now = Date.now()): MiaState {
  const next = cloneState(state);
  if (next.phase !== "revealing") return next;
  if (next.gameOver) {
    next.phase = "finished";
    next.pendingDoubt = null;
    next.deadlineAt = null;
    next.roundEndsAt = null;
    return next;
  }
  const loserId = next.nextStarterId;
  const loser = playerById(next, loserId ?? "");
  // The player who lost the life starts the next round; if that knocked them
  // out, the next living player after them does.
  const starter = loser && !loser.eliminated ? loser.id : nextLivingFrom(next, loserId);
  next.pendingDoubt = null;
  startRound(next, starter, now);
  next.roundEndsAt = next.deadlineAt;
  return next;
}

/**
 * The safest legal move for an idle player, per the agreed ruleset: doubt when
 * Mia stands or when nothing outranks the standing announcement, otherwise
 * believe and announce the minimum legal value.
 *
 * Returns a sequence because believing rolls the dice, and the announcement is
 * a separate decision that follows the roll.
 */
export function autoPlaySequence(state: MiaState, playerId: string): MiaAction[] {
  const moves = legalMoves(state, playerId);
  if (state.phase === "announcing") {
    const minimum = minimumAnnouncement(state.lastAnnouncement?.value ?? null);
    if (minimum !== null && moves.canAnnounce) return [{ type: "announce", playerId, value: minimum }];
    return [];
  }
  if (state.phase !== "deciding") return [];

  const standing = state.lastAnnouncement?.value ?? null;
  const minimum = minimumAnnouncement(standing);
  if (moves.canDoubt && (standing === MIA || !moves.canAnnounce)) {
    return [{ type: "doubt", playerId }];
  }
  if (state.lastAnnouncement === null) {
    // Opening the round: roll, then announce the lowest value.
    if (moves.canRoll && minimum !== null) {
      return [
        { type: "roll", playerId },
        { type: "announce", playerId, value: minimum },
      ];
    }
    return [];
  }
  if (moves.canBelieve && minimum !== null) {
    return [
      { type: "believe", playerId },
      { type: "announce", playerId, value: minimum },
    ];
  }
  if (moves.canDoubt) return [{ type: "doubt", playerId }];
  return [];
}

/** Minimum legal announcement above `standing`, or null when none exists. */
export function minimumAnnouncement(standing: number | null): number | null {
  const legal = legalAnnouncements(standing);
  return legal.length > 0 ? legal[legal.length - 1]! : null;
}

// ---------------------------------------------------------------------------
// Events and cloning
// ---------------------------------------------------------------------------

export function pushEvent(
  state: MiaState,
  at: number,
  kind: MiaEvent["kind"],
  text: string,
  extra: Partial<Omit<MiaEvent, "id" | "at" | "kind" | "text">> = {},
): void {
  state.logSeq += 1;
  state.events.push({ id: state.logSeq, at, kind, text, ...extra });
  if (state.events.length > 60) state.events.splice(0, state.events.length - 60);
}

export function cloneState(state: MiaState): MiaState {
  return structuredClone(state);
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** How much of a state snapshot one particular viewer is allowed to see. */
export interface Visibility {
  /** True when this player's dice count should be filled in. */
  ownDice: boolean;
  /** True when the announcer's actual dice are face up (reveal or later). */
  revealedDice: boolean;
  /** True when the winner's identity should be filled in. */
  winner: boolean;
}

export function visibilityFor(state: MiaState, viewerId: string): Visibility {
  const isOwner = state.diceOwnerId !== null && state.diceOwnerId === viewerId;
  const phaseShowsDice = state.phase === "revealing" || state.phase === "finished";
  return {
    ownDice: isOwner && !phaseShowsDice,
    revealedDice: phaseShowsDice,
    winner: state.gameOver !== null,
  };
}

/**
 * Strip what this viewer must not see. Dice are the only secret: they belong to
 * the player holding the cup, and become public the moment a doubt is called or
 * the game ends.
 */
export function redactState(state: MiaState, visibility: Visibility): MiaState {
  const view = cloneState(state);
  for (const player of view.players) {
    if (!visibility.ownDice && !visibility.revealedDice) {
      player.dice = null;
    }
  }
  if (!visibility.winner && view.gameOver) {
    // Keep the finished flag but hide who won until the reveal lands.
    view.gameOver = null;
  }
  return view;
}

export function buildView(state: MiaState, viewerId: string): MiaState {
  return redactState(state, visibilityFor(state, viewerId));
}
