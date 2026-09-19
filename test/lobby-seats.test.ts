/**
 * Lobby table occupancy is a count, not a roster. The dots have to tell
 * "nearly ready" from "just opened" without knowing who sits where, so the
 * first N points on the rim are filled and the rest are outlines.
 */
import { describe, expect, it } from "vitest";
import { MAX_PLAYERS } from "../src/shared/mia";
import { LOBBY_SEAT_RX, LOBBY_SEAT_RY, lobbySeats } from "../src/shared/lobby-seats";

describe("lobbySeats", () => {
  it("marks the first playerCount seats filled and the rest empty", () => {
    const seats = lobbySeats(3, MAX_PLAYERS);
    expect(seats).toHaveLength(MAX_PLAYERS);
    expect(seats.filter((seat) => seat.filled)).toHaveLength(3);
    expect(seats.slice(0, 3).every((seat) => seat.filled)).toBe(true);
    expect(seats.slice(3).every((seat) => !seat.filled)).toBe(true);
  });

  it("treats an empty table as a ring of outlines", () => {
    const seats = lobbySeats(0, MAX_PLAYERS);
    expect(seats).toHaveLength(MAX_PLAYERS);
    expect(seats.every((seat) => !seat.filled)).toBe(true);
  });

  it("caps a count that is already full", () => {
    const seats = lobbySeats(MAX_PLAYERS + 2, MAX_PLAYERS);
    expect(seats.every((seat) => seat.filled)).toBe(true);
  });

  it("puts the first seat at the head of the table", () => {
    const [first] = lobbySeats(1, MAX_PLAYERS);
    expect(first).toBeDefined();
    expect(first!.x).toBeCloseTo(50, 5);
    expect(first!.y).toBeCloseTo(50 - LOBBY_SEAT_RY, 5);
  });

  it("places every seat on the same ellipse", () => {
    for (const seat of lobbySeats(4, MAX_PLAYERS)) {
      const nx = (seat.x - 50) / LOBBY_SEAT_RX;
      const ny = (seat.y - 50) / LOBBY_SEAT_RY;
      expect(nx * nx + ny * ny).toBeCloseTo(1, 5);
    }
  });
});
