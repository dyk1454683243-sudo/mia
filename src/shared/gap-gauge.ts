/**
 * The gap gauge: how far the dice in your cup sit from the cheapest legal
 * announcement — the size of the lie.
 *
 * This is the same fact `renderAnnounceLadder` already has, drawn. The cheapest
 * claim is the last entry of `legalMoves.announcements` (the engine preserves
 * `RANKING` order, highest first). The rung count is the distance between those
 * two values *in `RANKING`*, never a numeric comparison: `11` outranks `65`
 * even though `11 > 65` is false, and subtracting the encoded rolls would
 * invent a second ranking rule.
 *
 * No snapshot field. The client already knows your dice (they are in the cup)
 * and the legal set (it drew the ladder from them). Putting the gap on the
 * wire would tell every other seat how far you have to climb.
 */
import { formatValue, MIA, RANKING } from "./mia";

export type GapKind = "climb" | "honest" | "open" | "empty";

export interface GapGauge {
  kind: GapKind;
  /** The roll in the cup. */
  held: number | null;
  /** Last entry of the announcements list the ladder already used. */
  cheapest: number | null;
  /**
   * `RANKING` index steps from `held` up to `cheapest`. Zero unless the kind
   * is `climb` — opening the round has no cut to be distant from, and an
   * honest held roll is not a lie.
   */
  rungs: number;
  /**
   * How far `cheapest` sits along the held→Mia track, 0..1. Null unless the
   * kind is `climb`, so an opener does not draw a fake forced-lie fill.
   */
  fill: number | null;
}

function rankIndex(value: number): number | null {
  const index = RANKING.indexOf(value);
  return index === -1 ? null : index;
}

/** A roll as the ladder already prints it: 21 is "MIA", never "2·1". */
export function gapValueLabel(value: number): string {
  return value === MIA ? "MIA" : formatValue(value);
}

/**
 * Derive the gauge from the ladder's own inputs. `announcements` is
 * `legalMoves(...).announcements`; `held` is `rollValue` of `you.dice`;
 * `standing` is `lastAnnouncement?.value` (null when the player opens).
 *
 * The function does not call `legalAnnouncements` or `outranks`. Re-deriving
 * the legal set from `standing` would be a second ranking rule, and it would
 * disagree the moment the ladder was handed a different list.
 */
export function gapGauge(
  announcements: readonly number[],
  held: number | null,
  standing: number | null,
): GapGauge {
  const cheapest = announcements.length > 0 ? announcements[announcements.length - 1]! : null;
  const heldIndex = held === null ? null : rankIndex(held);

  if (held === null || cheapest === null || heldIndex === null) {
    return { kind: "empty", held, cheapest, rungs: 0, fill: null };
  }

  // Opening is a degrade, not a climb of zero: there is no standing claim to
  // be distant from, even though every rung is legal and the held roll is in
  // the list. Check this before the honest-membership test.
  if (standing === null) {
    return { kind: "open", held, cheapest, rungs: 0, fill: null };
  }

  if (announcements.includes(held)) {
    return { kind: "honest", held, cheapest, rungs: 0, fill: null };
  }

  const cheapIndex = rankIndex(cheapest);
  const rungs = cheapIndex === null ? 0 : Math.max(0, heldIndex - cheapIndex);
  // The track's left edge is the held roll, its right edge is Mia. `heldIndex`
  // is how many rungs sit between those two, so it is the denominator; a
  // numeric span (`MIA - held`) would be the second ranking rule again.
  const fill = heldIndex === 0 ? 0 : rungs / heldIndex;
  return { kind: "climb", held, cheapest, rungs, fill };
}

function rungsPhrase(rungs: number): string {
  return rungs === 1 ? "one rung" : `${rungs} rungs`;
}

/** The sentence under the track. Colour is not the information. */
export function gapCopy(gauge: GapGauge): string {
  const { kind, held, cheapest, rungs } = gauge;
  if (kind === "open" && held !== null) {
    return `You open the round — any rung is legal. Your ${gapValueLabel(held)} is honest if you say it.`;
  }
  if (kind === "honest" && held !== null && cheapest !== null) {
    if (held === cheapest) {
      return `Your ${gapValueLabel(held)} is the cheapest legal claim — say it and you're honest.`;
    }
    return `Your ${gapValueLabel(held)} is legal. The cheapest claim is ${gapValueLabel(cheapest)} — say yours, or climb.`;
  }
  if (kind === "climb" && cheapest !== null) {
    return `The cheapest legal claim is ${gapValueLabel(cheapest)} — that's ${rungsPhrase(rungs)} above what you're holding. There is no honest move left.`;
  }
  return "";
}
