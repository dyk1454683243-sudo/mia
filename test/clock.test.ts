/**
 * Turn-countdown tests. The bug these pin: the drift between the client and
 * server clocks used to be measured inside the countdown itself, so
 * `deadline - (now - (now - serverTime))` collapsed to a constant and the
 * displayed number never moved between snapshots.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { COUNTDOWN_URGENT_SECONDS, TurnClock } from "../src/shared/clock";

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

describe("the countdown ring's clock", () => {
  /** The phase view at `remainingMs` before the deadline. */
  const viewAt = (clock: TurnClock, remainingMs: number) => {
    vi.setSystemTime(SERVER + (60_000 - remainingMs));
    const view = clock.countdown(SERVER, DEADLINE);
    if (view === null) throw new Error("expected a countdown");
    return view;
  };

  /**
   * The threshold is the feature: the ring reddens and the felt warms in the
   * last ten seconds. An implementation that turns urgent at the top of the
   * turn (or never) passes every "the red exists" browser check while being
   * wrong, so the boundary is pinned here at the millisecond.
   */
  it("turns urgent at ten seconds and stays calm above it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER);
    const clock = new TurnClock();
    clock.sync(SERVER);

    expect(viewAt(clock, 60_000)).toMatchObject({ seconds: 60, urgent: false });
    expect(viewAt(clock, 30_000)).toMatchObject({ seconds: 30, urgent: false });
    // One millisecond of the eleventh second is still calm...
    expect(viewAt(clock, 11_000)).toMatchObject({ seconds: 11, urgent: false });
    expect(viewAt(clock, 10_001)).toMatchObject({ seconds: 11, urgent: false });
    // ...and exactly ten seconds is where it turns.
    expect(viewAt(clock, 10_000)).toMatchObject({ seconds: 10, urgent: true });
    expect(viewAt(clock, 5_000)).toMatchObject({ seconds: 5, urgent: true });
    expect(viewAt(clock, 0)).toMatchObject({ seconds: 0, urgent: true });
    expect(COUNTDOWN_URGENT_SECONDS).toBe(10);
  });

  /**
   * The other deadline arming sites. `armRoundStart` (2s) and `resolveDoubt`'s
   * reveal (5s) pass the same `turnStartedAt`/`deadlineAt` pair as the turn
   * clock; every frame of them is inside the ten-second window, so a bare
   * `seconds <= 10` made the felt red for the whole round-start beat. The span
   * test is what distinguishes "about to run out" from "a short phase".
   */
  it("never calls a window at or under the threshold urgent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER);
    const clock = new TurnClock();
    clock.sync(SERVER);

    for (const span of [2_000, 5_000]) {
      const deadline = SERVER + span;
      for (const elapsed of [0, 1, span / 2, span - 1, span]) {
        vi.setSystemTime(SERVER + elapsed);
        expect(clock.countdown(SERVER, deadline), `${span}ms window at ${elapsed}ms`).toMatchObject({
          urgent: false,
        });
      }
    }
  });

  it("drains the fraction with the clock, clamped to [0, 1]", () => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER);
    const clock = new TurnClock();
    clock.sync(SERVER);

    expect(viewAt(clock, 60_000).fraction).toBe(1);
    expect(viewAt(clock, 45_000).fraction).toBeCloseTo(0.75, 3);
    expect(viewAt(clock, 30_000).fraction).toBeCloseTo(0.5, 3);
    expect(viewAt(clock, 0).fraction).toBe(0);
    // Past the deadline the server would have moved on; the ring stays empty.
    vi.setSystemTime(SERVER + 90_000);
    expect(clock.countdown(SERVER, DEADLINE)!.fraction).toBe(0);
  });

  it("leaves the ring full when the window start is missing", () => {
    const clock = new TurnClock();
    clock.sync(SERVER);
    expect(clock.countdown(null, DEADLINE)).toMatchObject({ fraction: 1, urgent: false });
  });

  it("has no countdown without a deadline", () => {
    const clock = new TurnClock();
    clock.sync(SERVER);
    expect(clock.countdown(SERVER, null)).toBeNull();
  });
});
