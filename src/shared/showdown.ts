/**
 * The showdown's verdict and clock, kept out of the DOM.
 *
 * The reveal is staged in three beats — the cup lifts, the dice tumble and
 * settle, the stamp lands — and every one of those beats is a *fraction of the
 * server's reveal window*, not a duration of its own. The window is the gap
 * between the moment the doubt was applied (`turnStartedAt`) and the deadline
 * the alarm will resolve on (`deadlineAt`), so a shortened clock under
 * `__setTimingsForTest` compresses the whole staging instead of desyncing from
 * it. `client/src/table.ts` turns this into CSS custom properties; the module
 * itself is pure so the `unit` project can pin it under plain Node (the browser
 * module queries `#app` at import and cannot be).
 */
import { escapeHtml } from "./html";
import { formatValue, MIA, type DoubtReveal } from "./mia";

/** Where the stamp's outcome comes from the engine's `DoubtReveal`. */
export type ShowdownStamp = "BLUFF" | "TRUE" | "MIA";

/** The emotional register, which drives the layout as well as the colour. */
export type ShowdownTone = "caught" | "believed" | "mia";

export interface ShowdownTiming {
  /** Total staged window in ms; 0 when there is no live window left. */
  span: number;
  /** How far into the window we are, clamped to `[0, span]`. */
  elapsed: number;
  /** 1 = cup lifts, 2 = dice tumble and settle, 3 = stamp lands. */
  beat: 1 | 2 | 3;
  /** True once the clock has reached the deadline (or there is no window). */
  done: boolean;
}

/**
 * Beat boundaries as fractions of the window. The cup owns the first fifth,
 * the dice most of the rest, and the stamp lands with enough of the window left
 * for the reader to take it in before the server resolves the reveal.
 */
export const CUP_BEAT_ENDS = 0.22;
export const DICE_BEAT_ENDS = 0.55;

/**
 * Which beat the reveal is in, from the same clock the countdown uses. A
 * missing `startedAt`/`deadlineAt` settles at beat 3 immediately and never
 * animates. That guard is defensive, not the game-ending path: `resolveDoubt`
 * does set `phase = "revealing"` with a deadline, but its trailing
 * `resolveEliminations` call flips a doubt that ends the game to `finished` and
 * clears `deadlineAt` in that same call, so the finished screen renders the
 * static recap and `showdownTiming` is never asked to stage that reveal.
 */
export function showdownTiming(
  startedAt: number | null,
  deadlineAt: number | null,
  now: number,
): ShowdownTiming {
  if (startedAt === null || deadlineAt === null) {
    return { span: 0, elapsed: 0, beat: 3, done: true };
  }
  const span = Math.max(1, deadlineAt - startedAt);
  const elapsed = Math.min(span, Math.max(0, now - startedAt));
  const progress = elapsed / span;
  return {
    span,
    elapsed,
    beat: progress < CUP_BEAT_ENDS ? 1 : progress < DICE_BEAT_ENDS ? 2 : 3,
    done: now >= deadlineAt,
  };
}

/**
 * The stamp that names the engine's verdict.
 *
 * - `verdict === "announcer"` is a caught bluff: the announcer did not beat what
 *   they claimed, so the announcer pays and the stamp is `BLUFF`.
 * - `penaltyApplied === "double-mia"` is the one case where doubting a *real*
 *   `21` costs the doubter two lives, so the stamp is the brass `MIA`.
 * - Anything else is an honest claim that the doubter was wrong to doubt, so
 *   the stamp is `TRUE`.
 */
export function showdownStamp(reveal: DoubtReveal): ShowdownStamp {
  if (reveal.verdict === "announcer") return "BLUFF";
  return reveal.penaltyApplied === "double-mia" ? "MIA" : "TRUE";
}

/** The layout register: a caught bluff and an honest claim never share one. */
export function showdownTone(reveal: DoubtReveal): ShowdownTone {
  if (reveal.verdict === "announcer") return "caught";
  return reveal.penaltyApplied === "double-mia" ? "mia" : "believed";
}

export interface ShowdownLoser {
  id: string;
  name: string;
  livesLost: number;
}

/**
 * Who pays. The engine charges the announcer when a bluff is caught and the
 * doubter otherwise — including the double charge for doubting a real Mia.
 * Naming the loser here, rather than inferring it in the view, is what keeps
 * the brass stamp on the doubter's side of the ledger.
 */
export function showdownLoser(reveal: DoubtReveal): ShowdownLoser {
  const announcerPays = reveal.verdict === "announcer";
  return {
    id: announcerPays ? reveal.announcerId : reveal.doubterId,
    name: announcerPays ? reveal.announcerName : reveal.doubterName,
    livesLost: reveal.livesLost,
  };
}

/** A roll value as it should read in prose: `21` is "MIA", never "2·1". */
export function showdownValue(value: number): string {
  return value === MIA ? "MIA" : formatValue(value);
}

/**
 * The factual one-liner under the stamp. It names what the announcer actually
 * held and what they claimed, and charges the player `resolveDoubt` actually
 * charged — the announcer when a bluff is caught, the doubter otherwise. It is
 * pure HTML-in-a-string so the MIA label and the double-penalty wording are
 * pinned by a unit test rather than only by a random browser game.
 */
export function showdownSentence(reveal: DoubtReveal): string {
  const penalty = reveal.penaltyApplied === "double-mia" ? " Doubled — the Mia was real." : "";
  const lives = `${reveal.livesLost} ${reveal.livesLost === 1 ? "life" : "lives"}`;
  if (reveal.verdict === "announcer") {
    return `${escapeHtml(reveal.announcerName)} had <b>${showdownValue(
      reveal.actual,
    )}</b> but claimed <b>${showdownValue(reveal.announced)}</b>. Bluff caught — loses ${lives}.${penalty}`;
  }
  return `${escapeHtml(reveal.announcerName)} really had <b>${showdownValue(
    reveal.actual,
  )}</b>, claimed <b>${showdownValue(reveal.announced)}</b>. ${escapeHtml(
    reveal.doubterName,
  )} doubted — loses ${lives}.${penalty}`;
}

