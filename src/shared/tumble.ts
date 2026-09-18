/**
 * The 400ms tumble that hides a die's face until it lands.
 *
 * The snapshot already carries the value; this is presentation only. A
 * `paint()` rebuild mid-tumble must resume, not restart, so the beat is a
 * function of `(startedAt, now)` rather than "the element just mounted".
 * Reduced motion skips the beat — the face and its accessible name appear
 * at once, matching the showdown's `prefers-reduced-motion` contract.
 *
 * Nothing about the move stamp or the turn clock may wait on this finishing.
 */
export const TUMBLE_MS = 400;

/** Accessible name while the face is still in the air. */
export const TUMBLE_ROLLING_LABEL = "rolling";

export interface TumbleTiming {
  /** Total tumble window in ms. */
  span: number;
  /** How far into the window we are, clamped to `[0, span]`. */
  elapsed: number;
  /** True once the face should be readable and named. */
  settled: boolean;
}

/**
 * Where a die is in its land. `startedAt` / `now` are the same clock
 * (typically `performance.now()`); they are not the server turn clock.
 */
export function tumbleTiming(startedAt: number, now: number, reducedMotion = false): TumbleTiming {
  if (reducedMotion) {
    return { span: TUMBLE_MS, elapsed: TUMBLE_MS, settled: true };
  }
  const elapsed = Math.min(TUMBLE_MS, Math.max(0, now - startedAt));
  return { span: TUMBLE_MS, elapsed, settled: elapsed >= TUMBLE_MS };
}

/**
 * The accessible name: withheld until the face is on screen, so a screen
 * reader cannot hear the value mid-tumble. Settled, it is the face itself.
 */
export function tumbleLabel(value: number, settled: boolean): string {
  return settled ? String(value) : TUMBLE_ROLLING_LABEL;
}
