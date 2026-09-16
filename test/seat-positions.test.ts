/**
 * The round table's rotation: whatever the seat count, the viewer's own chair is
 * the bottom-most point on the ring, and the other seats keep their ring order.
 *
 * Why this is a `unit` test and not part of `scripts/ui-check.ts`: the browser
 * harness always seats the viewer at index 0 (the browser creates the table and
 * the bots join after it), so `(index - viewerIndex)` is identically `index`
 * there and the viewer-centring term is dead code in every harness run. The
 * geometry is pure maths with no DOM, so it can be imported under plain Node and
 * checked across every seat count and every viewer index instead.
 */
import { describe, expect, it } from "vitest";
import { MAX_PLAYERS, MIN_PLAYERS } from "../src/shared/mia";
import { seatPositions, type SeatPoint } from "../src/shared/seat-positions";

/**
 * Screen-space bearing from the ring centre (50, 50): 90° points straight down.
 * The ellipse scales x and y independently, but `atan2` of the scaled components
 * is still strictly increasing in the seat's true angle, so sorting by bearing
 * recovers the order the seats sit in around the ring.
 */
function bearing(point: SeatPoint): number {
  return Math.atan2(point.y - 50, point.x - 50);
}

/** True when `order` is `0, 1, … count-1` rotated to any start. */
function isCyclicPlayerOrder(order: number[], count: number): boolean {
  return order.every((value, position) => order[(position + 1) % count] === (value + 1) % count);
}

describe("seatPositions", () => {
  it("puts the viewer's seat at the bottom of the ring for every count and viewer index", () => {
    for (let count = MIN_PLAYERS; count <= MAX_PLAYERS; count++) {
      for (let viewerIndex = 0; viewerIndex < count; viewerIndex++) {
        const points = seatPositions(count, viewerIndex);
        expect(points, `count ${count}`).toHaveLength(count);
        const label = `count ${count}, viewer ${viewerIndex}`;
        const you = points[viewerIndex]!;
        const lowestOther = Math.max(...points.filter((_, index) => index !== viewerIndex).map((point) => point.y));
        expect(you.y, label).toBeGreaterThan(lowestOther);
        // Bottom-most on the ellipse means directly below the centre too.
        expect(you.x, label).toBeCloseTo(50, 6);
      }
    }
  });

  it("keeps the remaining seats in player order around the ring", () => {
    for (let count = MIN_PLAYERS; count <= MAX_PLAYERS; count++) {
      for (let viewerIndex = 0; viewerIndex < count; viewerIndex++) {
        const points = seatPositions(count, viewerIndex);
        // Sweep the ring by bearing: the seat indices must come back in player
        // order, rotated to wherever the sweep starts. A swapped or mirrored
        // seat breaks the +1 step.
        const order = points
          .map((point, index) => ({ index, angle: bearing(point) }))
          .sort((a, b) => a.angle - b.angle)
          .map((entry) => entry.index);
        expect(isCyclicPlayerOrder(order, count), `count ${count}, viewer ${viewerIndex} order [${order.join(", ")}]`).toBe(true);
      }
    }
  });
});
