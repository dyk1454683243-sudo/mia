/**
 * The lives indicator's number and its assistive name, from one value.
 *
 * Seats already labelled the row for a screen reader:
 * `aria-label="${player.lives} of ${STARTING_LIVES} lives"`. Sighted players
 * still had to count identical dots, and a colourblind reader got a row of
 * similar shapes. The count next to the glyph is the half that does not wait
 * on #51's ornament. Both strings are derived here so they cannot disagree.
 *
 * `.pip.on` still counts the lives — this module does not change that contract.
 * `client/src/table.ts` cannot be imported under Node (it queries `#app` at
 * module scope), so the number lives here with the other DOM-free helpers.
 */
import { STARTING_LIVES } from "./mia";

export interface LivesIndicator {
  /** Remaining lives. The single source for the visible count and the label. */
  lives: number;
  starting: typeof STARTING_LIVES;
  /** Visible phrase beside the glyph: "4 lives", "1 life". */
  countText: string;
  /** Existing seat aria-label, kept so AT and the harness stay on the same string. */
  ariaLabel: string;
}

/** The visible count. Always starts with the same digits as `livesAriaLabel`. */
export function livesCountText(lives: number): string {
  return `${lives} ${lives === 1 ? "life" : "lives"}`;
}

/** The assistive name already used on seats. */
export function livesAriaLabel(lives: number): string {
  return `${lives} of ${STARTING_LIVES} lives`;
}

/**
 * One object, one `lives` argument. The view reads both strings from here
 * rather than writing the number twice.
 */
export function livesIndicator(lives: number): LivesIndicator {
  return {
    lives,
    starting: STARTING_LIVES,
    countText: livesCountText(lives),
    ariaLabel: livesAriaLabel(lives),
  };
}

/** Whether pip `index` (0-based) is still on. The harness counts `.pip.on`. */
export function lifePipOn(index: number, lives: number): boolean {
  return index >= 0 && index < lives;
}
