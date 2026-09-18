/**
 * The endgame replay: the last round as a filmstrip, and the lines that fall out
 * of each player's record.
 *
 * Pure and DOM-free like `showdown.ts`, so the frames, the sentences and the
 * honest-winner gate are unit-tested under plain Node rather than only being
 * seen in one random browser game. `client/src/table.ts` renders what this
 * returns and decides nothing.
 *
 * The claims come out of `MiaState.events` — the room already keeps every
 * announcement of the round that ended the game, and the ring buffer's 60
 * entries always reach back past the last `round` event (a round cannot exceed
 * ~21 announcements, each preceded by one believe or roll, plus the reveal).
 * The doubt and the dice are read from `lastReveal`, the engine's typed verdict,
 * rather than re-deriving the ranking rule in a second place.
 */
import { escapeHtml } from "./html";
import { playerById, type MiaPlayer, type MiaState, type PlayerRecord, type DoubtReveal } from "./mia";
import { showdownLoser, showdownValue } from "./showdown";

// ---------------------------------------------------------------------------
// The filmstrip
// ---------------------------------------------------------------------------

export interface ClaimFrame {
  kind: "claim";
  playerId: string;
  playerName: string;
  value: number;
}

export interface DoubtFrame {
  kind: "doubt";
  playerId: string;
  playerName: string;
}

export interface TruthFrame {
  kind: "truth";
  playerId: string;
  playerName: string;
  /** The roll that was actually in the cup. */
  value: number;
  /** What the player claimed it was. */
  announced: number;
  /** True when the doubt caught the announcer's bluff. */
  bluff: boolean;
  livesLost: number;
  penaltyApplied: DoubtReveal["penaltyApplied"];
}

export type FilmFrame = ClaimFrame | DoubtFrame | TruthFrame;

export interface Filmstrip {
  /** The round the game ended in. */
  round: number;
  frames: FilmFrame[];
  /** One factual sentence for under the strip, safe to inject as HTML. */
  caption: string;
}

/**
 * The last round, frame by frame: every claim in order, the doubt, the truth.
 * The game can only end on a doubt, so a finished state always has both a
 * `lastReveal` and a final round's worth of claims behind it.
 */
export function lastRoundFilmstrip(state: MiaState): Filmstrip {
  const frames: FilmFrame[] = [];
  for (const event of finalRoundEvents(state)) {
    if (event.kind !== "announce" || event.playerId === undefined || event.value === undefined) continue;
    frames.push({
      kind: "claim",
      playerId: event.playerId,
      playerName: nameOf(state, event.playerId),
      value: event.value,
    });
  }
  const reveal = state.lastReveal;
  if (reveal) {
    frames.push({ kind: "doubt", playerId: reveal.doubterId, playerName: reveal.doubterName });
    frames.push({
      kind: "truth",
      playerId: reveal.announcerId,
      playerName: reveal.announcerName,
      value: reveal.actual,
      announced: reveal.announced,
      bluff: reveal.verdict === "announcer",
      livesLost: reveal.livesLost,
      penaltyApplied: reveal.penaltyApplied,
    });
  }
  return { round: state.round, frames, caption: filmstripCaption(state) };
}

/**
 * Every event from the start of the final round on. The last `round` event is
 * the boundary; walking backwards is safe because the ring buffer keeps the
 * most recent 60, and the tail is always inside that window.
 */
function finalRoundEvents(state: MiaState): MiaState["events"] {
  for (let index = state.events.length - 1; index >= 0; index--) {
    if (state.events[index]!.kind === "round") return state.events.slice(index + 1);
  }
  return state.events;
}

function nameOf(state: MiaState, playerId: string): string {
  return state.players.find((player) => player.id === playerId)?.name ?? "Someone";
}

/**
 * What the doubt settled, in one sentence. Everything factual here comes from
 * the engine's reveal (which side paid, how much, whether the Mia was real), so
 * the caption cannot disagree with the verdict the stamp shows.
 */
function filmstripCaption(state: MiaState): string {
  const reveal = state.lastReveal;
  const winner = state.gameOver;
  if (!reveal) return winner ? `${escapeHtml(winner.winnerName)} wins.` : "The game is over.";
  const loser = showdownLoser(reveal);
  const tail = `${escapeHtml(loser.name)} lost ${
    reveal.livesLost === 2 ? "two" : "their last life"
  } and the game.`;
  if (reveal.penaltyApplied === "double-mia") {
    // No possessive on the announcer's name: the Culture ship names this app
    // hands out include ones ending in "s" and "?", and "Instructions's MIA"
    // is not a sentence anyone wants to read.
    return `${escapeHtml(reveal.doubterName)} doubted ${escapeHtml(
      reveal.announcerName,
    )} — and the MIA was real. ${tail}`;
  }
  const head =
    reveal.verdict === "announcer"
      ? `${escapeHtml(reveal.announcerName)} claimed ${showdownValue(reveal.announced)} on a ${showdownValue(reveal.actual)}.`
      : `${escapeHtml(reveal.announcerName)} really did have ${showdownValue(reveal.actual)}.`;
  return `${head} ${tail}`;
}

// ---------------------------------------------------------------------------
// The stat lines
// ---------------------------------------------------------------------------

/**
 * Who a stat line is about. The templates are written in the past tense on
 * purpose: the third person then needs no verb agreement, so "You told the
 * truth twice" and "Damp Ferret told the truth twice" cannot drift apart.
 */
export interface Voice {
  /** Sentence-start subject: "You" or a player's name. */
  subject: string;
  object: string;
  possessive: string;
}

export const YOU: Voice = { subject: "You", object: "you", possessive: "your" };

export function thirdPerson(name: string): Voice {
  return { subject: name, object: "them", possessive: "their" };
}

export function voiceFor(player: MiaPlayer, viewerId: string): Voice {
  return player.id === viewerId ? YOU : thirdPerson(player.name);
}

/**
 * The sentences for one player: at most two, both guarded. A player who never
 * announced gets the cup line rather than a vacuous "told the truth 0 times",
 * and a player who never doubted gets no doubt line at all.
 */
export function statLines(record: PlayerRecord, voice: Voice): string[] {
  const lines = [claimedLine(record, voice), doubtLine(record, voice)];
  return lines.filter((line): line is string => line !== null);
}

function claimedLine(record: PlayerRecord, voice: Voice): string {
  if (record.announcements === 0) return `${voice.subject} never picked up the cup.`;
  if (record.truths === 0) {
    return record.caught > 0
      ? `${voice.subject} never named ${voice.possessive} real roll, and got caught ${times(record.caught)}.`
      : `${voice.subject} never named ${voice.possessive} real roll, and nobody ever caught on.`;
  }
  const told = `${voice.subject} told the truth ${times(record.truths)} all game.`;
  if (record.truthsDoubted === record.truths) {
    return `${told} ${
      record.truths === 1
        ? `Nobody believed ${voice.object}.`
        : record.truths === 2
          ? `Both times, nobody believed ${voice.object}.`
          : `Nobody believed ${voice.object} any of those times.`
    }`;
  }
  if (record.truthsDoubted > 0) {
    return `${told} ${
      record.truthsDoubted === 1
        ? `Somebody still doubted ${voice.object} once.`
        : `Somebody still doubted ${voice.object} ${times(record.truthsDoubted)}.`
    }`;
  }
  return told;
}

function doubtLine(record: PlayerRecord, voice: Voice): string | null {
  if (record.doubts === 0) return null;
  const called = `${voice.subject} called ${count(record.doubts, "doubt")}`;
  if (record.doubtsCorrect === record.doubts) return `${called} and got it right every time.`;
  if (record.doubtsCorrect === 0) return `${called} and got every one wrong.`;
  return `${called} and got it right ${times(record.doubtsCorrect)}.`;
}

/** `1` -> "once", `2` -> "twice", `n` -> "n times". */
function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// The numbers and the finishing order
// ---------------------------------------------------------------------------

export interface StatChip {
  label: string;
  value: string;
}

/**
 * The viewer's headline numbers. A player who never claimed has no liar rate to
 * print — a "0%" there would be a claim about nothing — so their doubt record is
 * shown instead.
 */
export function playerChips(record: PlayerRecord): StatChip[] {
  const { announcements, truths, doubts, doubtsCorrect, caught } = record;
  if (announcements > 0) {
    const bluffs = announcements - truths;
    return [
      { label: "Claims", value: String(announcements) },
      { label: "Bluffs", value: String(bluffs) },
      { label: "Caught", value: String(caught) },
      { label: "Liar rate", value: `${Math.round((bluffs / announcements) * 100)}%` },
    ];
  }
  if (doubts > 0) {
    return [
      { label: "Doubts", value: String(doubts) },
      { label: "Right", value: String(doubtsCorrect) },
    ];
  }
  return [];
}

/**
 * How a player finished, under their name: the winner's remaining lives, or the
 * round that knocked them out. `roundsPlayed` counts the rounds a player was
 * alive for, so an elimination during round 12 reads "out in round 12".
 */
export function playerOutcome(player: MiaPlayer): string {
  if (!player.eliminated) return `${player.lives} ${player.lives === 1 ? "life" : "lives"} left`;
  return `out in round ${player.roundsPlayed}`;
}

/** A roll value as it reads in the filmstrip: Mia is "MIA", never "2·1". */
export function frameLabel(value: number): string {
  return showdownValue(value);
}

// ---------------------------------------------------------------------------
// The honest-player badge
// ---------------------------------------------------------------------------

/**
 * The sentence the result card shouts when the winner never bluffed. The
 * lookbook's wording, not a new one: "never once" is the point, and "roughly
 * never" is why it is loud.
 */
export const HONEST_BADGE_LABEL = "Never once bluffed";

/**
 * Claims that were not the roll in the cup. Same count `playerChips` prints as
 * "Bluffs": anything other than an exact name of the dice, including a claim
 * *below* the real roll. The badge and the chips have to agree, so this is not
 * a second ranking comparison.
 */
export function bluffsOf(record: PlayerRecord): number {
  return Math.max(0, record.announcements - record.truths);
}

/**
 * True when this player announced at least once and every claim named the roll.
 * A player who never picked up the cup does not qualify by vacuum — that is a
 * win by other people's mistakes, not an honest game.
 */
export function neverBluffed(record: PlayerRecord): boolean {
  return record.announcements > 0 && bluffsOf(record) === 0;
}

/**
 * The winner, if they announced at least once and never bluffed across the
 * *whole* game. Reads the engine's `PlayerRecord` rather than walking the log
 * or re-deriving `outranks`: the log is a ring buffer and cannot score an
 * undoubted claim, which is exactly the claim this badge has to count, and
 * `truths` is already the engine's verdict of whether a claim named the cup.
 *
 * A loser who never bluffed is not named. An honest last round is not enough
 * if an earlier claim was a bluff. `null` before `gameOver`, and `null` on a
 * mid-game view whose records have been redacted — the tally is not news
 * until the game is over.
 */
export function honestWinner(state: MiaState): MiaPlayer | null {
  const winnerId = state.gameOver?.winnerId;
  if (!winnerId) return null;
  const winner = playerById(state, winnerId);
  if (!winner?.record || !neverBluffed(winner.record)) return null;
  return winner;
}
