/**
 * Turn-countdown tests. The bug these pin: the drift between the client and
 * server clocks used to be measured inside the countdown itself, so
 * `deadline - (now - (now - serverTime))` collapsed to a constant and the
 * displayed number never moved between snapshots.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnClock } from "../src/shared/clock";

const SERVER = 1_700_000_000_000;
const DEADLINE = SERVER + 60_000;

afterEach(() => {
  vi.useRealTimers();
});

describe("TurnClock", () => {
  it("counts down on every tick from a single snapshot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER);
    const clock = new TurnClock();
    clock.sync(SERVER); // one snapshot; no further syncs below

    expect(clock.secondsLeft(DEADLINE)).toBe(60);
    const ticks: [elapsed: number, expected: number][] = [
      [1_000, 59],
      [30_000, 30],
      [59_000, 1],
      [59_999, 1],
      [60_000, 0],
      [90_000, 0],
    ];
    for (const [elapsed, expected] of ticks) {
      vi.setSystemTime(SERVER + elapsed);
      expect(clock.secondsLeft(DEADLINE), `${elapsed}ms after the snapshot`).toBe(expected);
    }
  });

  it("stays sane when the client clock is minutes away from the server", () => {
    vi.useFakeTimers();
    const skew = 5 * 60_000;

    // Five minutes ahead when the snapshot arrives.
    vi.setSystemTime(SERVER + skew);
    const ahead = new TurnClock();
    ahead.sync(SERVER);
    expect(ahead.secondsLeft(DEADLINE)).toBe(60);
    vi.setSystemTime(SERVER + skew + 10_000);
    expect(ahead.secondsLeft(DEADLINE)).toBe(50);

    // Five minutes behind.
    vi.setSystemTime(SERVER - skew);
    const behind = new TurnClock();
    behind.sync(SERVER);
    expect(behind.secondsLeft(DEADLINE)).toBe(60);
    vi.setSystemTime(SERVER - skew + 10_000);
    expect(behind.secondsLeft(DEADLINE)).toBe(50);
  });

  it("re-measures the drift when a fresh snapshot arrives", () => {
    vi.useFakeTimers();
    const clock = new TurnClock();

    vi.setSystemTime(SERVER);
    clock.sync(SERVER);
    expect(clock.secondsLeft(DEADLINE)).toBe(60);

    // Half a minute in, a new snapshot carries a new server time and deadline.
    const nextServerTime = SERVER + 30_000;
    const nextDeadline = nextServerTime + 45_000;
    vi.setSystemTime(nextServerTime);
    clock.sync(nextServerTime);
    expect(clock.secondsLeft(nextDeadline)).toBe(45);
    vi.setSystemTime(nextServerTime + 5_000);
    expect(clock.secondsLeft(nextDeadline)).toBe(40);
  });

  it("returns null when nothing is on the clock", () => {
    const clock = new TurnClock();
    clock.sync(SERVER);
    expect(clock.secondsLeft(null)).toBeNull();
  });

  it("exposes the same live clock in server time", () => {
    vi.useFakeTimers();
    // Client half a minute ahead of the server when the snapshot lands.
    vi.setSystemTime(SERVER + 30_000);
    const clock = new TurnClock();
    clock.sync(SERVER);
    expect(clock.now()).toBe(SERVER);
    vi.setSystemTime(SERVER + 30_000 + 2_500);
    expect(clock.now()).toBe(SERVER + 2_500);
  });
});
