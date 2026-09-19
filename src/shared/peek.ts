/**
 * When the viewer's own cup sits closed over their dice.
 *
 * Covering is client-side presentation on top of the seat contract:
 * `.player-dice` is still emitted whenever the snapshot carries dice.
 * `visibilityFor` is what actually keeps other people's dice out of the
 * JSON and must not be touched. This helper only answers "should this
 * viewer's already-redacted pair sit under a lid?"
 *
 * Revealed and finished pairs stay face-up: the showdown and the filmstrip
 * are the moments the table is allowed to look.
 */
import type { Phase } from "./mia";

export function cupCoversOwnDice(phase: Phase, isYou: boolean, hasDice: boolean): boolean {
  if (!isYou || !hasDice) return false;
  return phase === "roundStart" || phase === "deciding" || phase === "announcing";
}
