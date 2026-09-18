/**
 * Whether a seat should draw the thinking ellipsis.
 *
 * The decision is kept out of the DOM so the `unit` project can pin it under
 * Node. `client/src/table.ts` cannot be imported there — it queries `#app` at
 * module scope — and the browser harness never disconnects a bot mid-turn, so
 * it cannot reach the offline-versus-thinking rule at all.
 *
 * The seat already knows it is the active one (`turn` from `game.turnPlayerId`).
 * The ellipsis is the inhabited-table tell, so it stays off when that player is
 * offline: a dropped phone must read as offline, not as a long think.
 * Eliminated chairs keep their place on the ring but never think.
 */
export function seatIsThinking(seat: {
  turn: boolean;
  offline: boolean;
  eliminated: boolean;
}): boolean {
  return seat.turn && !seat.offline && !seat.eliminated;
}
