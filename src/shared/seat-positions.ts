/**
 * Seat geometry for the round table. It lives in `src/shared/` — pure TypeScript
 * with no DOM and no Cloudflare imports — so the `unit` Vitest project can import
 * it under plain Node, alongside the clock arithmetic.
 *
 * `client/src/table.ts` cannot be imported there: it queries `#app` at module
 * scope. And the browser harness cannot reach the rotation either, because it
 * always seats the viewer at index 0 (the browser creates the table and the bots
 * join after it). Unit-testing this module is what pins the viewer-centring
 * across every seat count and viewer index.
 */

export interface SeatPoint {
  /** Percentage across the felt, 0 (left) to 100 (right). */
  x: number;
  /** Percentage down the felt, 0 (top) to 100 (bottom). */
  y: number;
}

/**
 * A spectator holds no chair, so there is no "me at the foot" to rotate
 * toward. Every watcher uses seat 0 — the first player who sat, usually the
 * creator — as the origin. A different origin per tab would spin the ring
 * whenever someone opened the TV URL; a fixed one keeps every screen in the
 * room looking at the same table.
 */
export const SPECTATOR_VIEWER_INDEX = 0;

/**
 * Which seat the ring is rotated from. `you` on a spectator snapshot is still
 * the socket's player id (it may even be a seated player's), so "find my seat"
 * is the wrong question — the `spectator` flag is the one that decides.
 */
export function tableViewerIndex(
  spectator: boolean,
  you: string,
  playerIds: readonly string[],
): number {
  if (spectator) return SPECTATOR_VIEWER_INDEX;
  const index = playerIds.indexOf(you);
  return index < 0 ? 0 : index;
}

/**
 * The `you` seat treatment. A spectator is never "you", even when `you` is a
 * seated player's id (same cookie, watching socket).
 */
export function isViewerSeat(spectator: boolean, playerId: string, you: string): boolean {
  return !spectator && playerId === you;
}

/**
 * Seat centres on an ellipse, rotated so the viewer is always at the bottom —
 * the way it works at a real table. The ring is drawn as one CSS circle behind
 * the seats; these are only the points the seats hang from. The radius tightens
 * from seven seats up, because eight evenly spaced avatars need a smaller ring
 * and shorter labels than five do.
 */
export function seatPositions(count: number, viewerIndex: number): SeatPoint[] {
  const rx = count >= 7 ? 0.78 : 0.82;
  const ry = count >= 7 ? 0.76 : 0.8;
  return Array.from({ length: count }, (_, index) => {
    // Screen coordinates: 90° is straight down, so the viewer sits at the foot.
    const angle = Math.PI / 2 + ((index - viewerIndex) / count) * Math.PI * 2;
    return {
      x: 50 + 50 * Math.cos(angle) * rx,
      y: 50 + 50 * Math.sin(angle) * ry,
    };
  });
}
