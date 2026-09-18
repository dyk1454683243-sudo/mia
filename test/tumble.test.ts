/**
 * The land is a pure, DOM-free transform of (startedAt, now, reducedMotion),
 * so it can be pinned under plain Node the way the showdown beats and the
 * seat geometry are. `client/src/table.ts` cannot be imported here (it
 * queries `#app` at import), which is why the clock and the accessible name
 * live in `src/shared/tumble.ts`.
 *
 * The three properties worth guarding:
 *
 * - the face stays unnamed until the 400ms beat elapses;
 * - a snapshot mid-tumble reports the elapsed offset, not a restart at 0;
 * - reduced motion skips the beat, so the value is named at once.
 */
import { describe, expect, it } from "vitest";
import { TUMBLE_MS, TUMBLE_ROLLING_LABEL, tumbleLabel, tumbleTiming } from "../src/shared/tumble";

describe("tumbleTiming", () => {
  const START = 1_000;

  it("is in the air at the first frame", () => {
    expect(tumbleTiming(START, START)).toMatchObject({ span: TUMBLE_MS, elapsed: 0, settled: false });
  });

  it("is still in the air halfway through the beat", () => {
    const mid = tumbleTiming(START, START + TUMBLE_MS / 2);
    expect(mid.settled).toBe(false);
    expect(mid.elapsed).toBe(TUMBLE_MS / 2);
  });

  it("has settled once the beat elapses", () => {
    expect(tumbleTiming(START, START + TUMBLE_MS)).toMatchObject({
      elapsed: TUMBLE_MS,
      settled: true,
    });
    expect(tumbleTiming(START, START + TUMBLE_MS + 250).elapsed).toBe(TUMBLE_MS);
  });

  it("resumes from elapsed time instead of restarting", () => {
    // A paint() rebuild 180ms in must hand CSS the same offset, or the die
    // restarts and a stream of snapshots leaves it stuck in the air.
    expect(tumbleTiming(START, START + 180).elapsed).toBe(180);
    expect(tumbleTiming(START, START + 180).settled).toBe(false);
  });

  it("never rolls when the reader prefers reduced motion", () => {
    expect(tumbleTiming(START, START, true).settled).toBe(true);
    expect(tumbleTiming(START, START, true).elapsed).toBe(TUMBLE_MS);
  });

  it("clamps a clock that runs backwards to the first frame", () => {
    expect(tumbleTiming(START, START - 50)).toMatchObject({ elapsed: 0, settled: false });
  });
});

describe("tumbleLabel", () => {
  it("withholds the face until the die has settled", () => {
    expect(tumbleLabel(5, false)).toBe(TUMBLE_ROLLING_LABEL);
    expect(tumbleLabel(5, false)).not.toBe("5");
  });

  it("names the face once it has landed", () => {
    expect(tumbleLabel(5, true)).toBe("5");
    expect(tumbleLabel(1, true)).toBe("1");
  });
});
