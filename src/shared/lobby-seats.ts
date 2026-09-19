/**
 * Rim seats for a lobby table. Pure geometry with no DOM, so the unit project
 * can pin "filled vs outline" without opening a browser.
 *
 * Which seats are occupied is cosmetic — `TableSummary` has a count, not
 * identities — so the first `playerCount` points around the ellipse are filled
 * and the rest are empty. The arrangement is clockwise from twelve o'clock.
 */
export interface LobbySeat {
  filled: boolean;
  /** Percentage across the felt, 0 (left) to 100 (right). */
  x: number;
  /** Percentage down the felt, 0 (top) to 100 (bottom). */
  y: number;
}

/** Horizontal radius of the rim, as a percentage of the felt's width. */
export const LOBBY_SEAT_RX = 46;
/** Vertical radius of the rim, as a percentage of the felt's height. */
export const LOBBY_SEAT_RY = 41;

export function lobbySeats(playerCount: number, maxPlayers: number): LobbySeat[] {
  const max = Math.max(0, Math.trunc(maxPlayers));
  const filled = Math.max(0, Math.min(Math.trunc(playerCount), max));
  if (max === 0) return [];
  return Array.from({ length: max }, (_, index) => {
    // Screen coordinates: −90° is straight up, so seat 0 sits at the head.
    const angle = -Math.PI / 2 + (index / max) * Math.PI * 2;
    return {
      filled: index < filled,
      x: 50 + LOBBY_SEAT_RX * Math.cos(angle),
      y: 50 + LOBBY_SEAT_RY * Math.sin(angle),
    };
  });
}
