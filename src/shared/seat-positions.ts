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
