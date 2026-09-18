/**
 * The waiting-room practice cup is local: a thumb toy, not a move. The tumble
 * is the same 400ms beat the lookbook asked for of real dice (#55), kept here
 * so the waiting room can hide the value until the dice settle without waiting
 * on that issue, and so a snapshot that rebuilds the page mid-shake can ask
 * "are we still in the air?" from the clock rather than from the DOM.
 *
 * Reduced motion skips the beat entirely — the value is allowed to appear at
 * once, matching the showdown's `prefers-reduced-motion` contract.
 */
export const PRACTICE_ROLL_MS = 400;

export function practiceIsRolling(startedAt: number, now: number, reducedMotion: boolean): boolean {
  if (reducedMotion) return false;
  return now - startedAt < PRACTICE_ROLL_MS;
}
