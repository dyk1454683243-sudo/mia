/**
 * Shake-to-roll. The browser harness cannot shake a phone, and it cannot
 * prove a walking gait did not fire — Chromium has no DeviceMotion to
 * drive. The detector, the one-roll-per-turn gate, the Space filter and
 * the iOS "do not ask on load" plan are pure, so they live here.
 */
import { describe, expect, it } from "vitest";
import {
  GRAVITY_MS2,
  RATTLE_THRESHOLD_MS2,
  SHAKE_COOLDOWN_MS,
  SHAKE_MIN_PEAK_GAP_MS,
  SHAKE_THRESHOLD_MS2,
  SHAKE_WINDOW_MS,
  ShakeDetector,
  deviceMotionNeedsPermission,
  gestureRollAction,
  motionListenPlan,
  motionMagnitude,
  rollEffectsAllowed,
  shouldSendRoll,
  spaceIsRollKey,
  spaceShouldRoll,
} from "../src/shared/shake-to-roll";

function axes(x: number, y: number, z: number) {
  return { x, y, z };
}

function shakePeaks(detector: ShakeDetector, at: number, count = 3): ReturnType<ShakeDetector["sample"]> {
  let last = { shake: false, rattling: false };
  for (let i = 0; i < count; i++) {
    last = detector.sample(SHAKE_THRESHOLD_MS2 + 4, at + i * SHAKE_MIN_PEAK_GAP_MS);
  }
  return last;
}

describe("motionMagnitude", () => {
  it("prefers user acceleration when the axes are actually populated", () => {
    expect(
      motionMagnitude({
        acceleration: axes(3, 4, 0),
        accelerationIncludingGravity: axes(0, 0, GRAVITY_MS2),
      }),
    ).toBe(5);
  });

  it("falls back to the excess over 1g when user acceleration is missing", () => {
    expect(
      motionMagnitude({
        acceleration: null,
        accelerationIncludingGravity: axes(0, 0, GRAVITY_MS2 + 2),
      }),
    ).toBeCloseTo(2);
  });

  it("treats exact-zero user axes as unsupported and uses gravity instead", () => {
    expect(
      motionMagnitude({
        acceleration: axes(0, 0, 0),
        accelerationIncludingGravity: axes(0, 0, GRAVITY_MS2 + 5),
      }),
    ).toBeCloseTo(5);
  });

  it("returns null when the event has no usable axes", () => {
    expect(motionMagnitude({ acceleration: null, accelerationIncludingGravity: null })).toBeNull();
    expect(
      motionMagnitude({
        acceleration: { x: 1, y: null, z: 0 },
        accelerationIncludingGravity: null,
      }),
    ).toBeNull();
  });
});

describe("ShakeDetector", () => {
  it("does not roll for a walking gait well below the threshold", () => {
    const detector = new ShakeDetector();
    const walk = 4;
    expect(walk).toBeLessThan(SHAKE_THRESHOLD_MS2);
    for (let i = 0; i < 80; i++) {
      const sample = detector.sample(walk, i * 16);
      expect(sample.shake, `step ${i}`).toBe(false);
    }
  });

  it("does not treat a single bump as a shake", () => {
    const detector = new ShakeDetector();
    expect(detector.sample(SHAKE_THRESHOLD_MS2 + 10, 0).shake).toBe(false);
    expect(detector.sample(SHAKE_THRESHOLD_MS2 + 10, SHAKE_MIN_PEAK_GAP_MS).shake).toBe(false);
  });

  it("fires once after enough distinct peaks, then stays quiet through the cooldown", () => {
    const detector = new ShakeDetector();
    const first = shakePeaks(detector, 1_000);
    expect(first.shake).toBe(true);
    expect(first.rattling).toBe(false);

    const duringCooldown = shakePeaks(detector, 1_000 + SHAKE_MIN_PEAK_GAP_MS * 3);
    expect(duringCooldown.shake).toBe(false);
    expect(duringCooldown.rattling).toBe(false);
  });

  it("can fire again only after the cooldown, not because the window rolled", () => {
    const detector = new ShakeDetector();
    expect(shakePeaks(detector, 0).shake).toBe(true);
    expect(shakePeaks(detector, SHAKE_WINDOW_MS + 1).shake).toBe(false);
    expect(shakePeaks(detector, SHAKE_COOLDOWN_MS + SHAKE_WINDOW_MS).shake).toBe(true);
  });

  it("ignores a sample burst that is one spike counted three times", () => {
    const detector = new ShakeDetector();
    expect(detector.sample(20, 0).shake).toBe(false);
    expect(detector.sample(20, 10).shake).toBe(false);
    expect(detector.sample(20, 20).shake).toBe(false);
  });

  it("marks a rattle below the shake threshold and drops it under cooldown", () => {
    const detector = new ShakeDetector();
    const rattle = detector.sample(RATTLE_THRESHOLD_MS2 + 1, 0);
    expect(rattle.rattling).toBe(true);
    expect(rattle.shake).toBe(false);
    expect(detector.sample(null, 1).rattling).toBe(false);
  });

  it("reset clears a half-built shake so a reconnect cannot finish it", () => {
    const detector = new ShakeDetector();
    detector.sample(SHAKE_THRESHOLD_MS2 + 4, 0);
    detector.sample(SHAKE_THRESHOLD_MS2 + 4, SHAKE_MIN_PEAK_GAP_MS);
    detector.reset();
    expect(detector.sample(SHAKE_THRESHOLD_MS2 + 4, SHAKE_MIN_PEAK_GAP_MS * 2).shake).toBe(false);
  });
});

describe("gestureRollAction", () => {
  it("sends believe when that is the legal cup take, roll when opening", () => {
    expect(gestureRollAction({ canRoll: false, canBelieve: true })).toBe("believe");
    expect(gestureRollAction({ canRoll: true, canBelieve: false })).toBe("roll");
  });

  it("sends nothing off-turn or when only doubt is on offer", () => {
    expect(gestureRollAction({ canRoll: false, canBelieve: false })).toBeNull();
  });

  it("prefers believe if both flags were ever true together", () => {
    expect(gestureRollAction({ canRoll: true, canBelieve: true })).toBe("believe");
  });
});

describe("shouldSendRoll", () => {
  it("allows the first send against a snapshot and refuses a second on the same logSeq", () => {
    expect(shouldSendRoll(null, 4)).toBe(true);
    expect(shouldSendRoll(4, 4)).toBe(false);
    expect(shouldSendRoll(4, 5)).toBe(true);
  });
});

describe("spaceShouldRoll", () => {
  it("treats Space as the desktop shake and ignores other keys", () => {
    expect(spaceIsRollKey(" ")).toBe(true);
    expect(spaceIsRollKey("Spacebar")).toBe(true);
    expect(spaceIsRollKey("Enter")).toBe(false);
    expect(
      spaceShouldRoll({ key: " ", repeat: false, editing: false, focusedAction: null }),
    ).toBe(true);
    expect(
      spaceShouldRoll({ key: "Enter", repeat: false, editing: false, focusedAction: null }),
    ).toBe(false);
  });

  it("does not steal Space from a held key, a text field, or a focused Doubt", () => {
    expect(
      spaceShouldRoll({ key: " ", repeat: true, editing: false, focusedAction: null }),
    ).toBe(false);
    expect(
      spaceShouldRoll({ key: " ", repeat: false, editing: true, focusedAction: null }),
    ).toBe(false);
    expect(
      spaceShouldRoll({ key: " ", repeat: false, editing: false, focusedAction: "doubt" }),
    ).toBe(false);
  });

  it("still rolls when Space lands on the Roll or Believe button itself", () => {
    expect(
      spaceShouldRoll({ key: " ", repeat: false, editing: false, focusedAction: "roll" }),
    ).toBe(true);
    expect(
      spaceShouldRoll({ key: " ", repeat: false, editing: false, focusedAction: "believe" }),
    ).toBe(true);
  });
});

describe("motionListenPlan", () => {
  it("never asks on load: iOS waits for a tap, a laptop does nothing, Android may listen", () => {
    expect(motionListenPlan(true, true)).toBe("wait-for-gesture");
    expect(motionListenPlan(true, false)).toBe("listen");
    expect(motionListenPlan(false, false)).toBe("none");
    expect(motionListenPlan(false, true)).toBe("none");
  });

  it("detects the iOS permission function without calling it", () => {
    const ios = Object.assign(function DeviceMotionEvent() {}, {
      requestPermission: () => Promise.resolve("granted"),
    });
    expect(deviceMotionNeedsPermission(ios)).toBe(true);
    expect(deviceMotionNeedsPermission(function DeviceMotionEvent() {})).toBe(false);
    expect(deviceMotionNeedsPermission(undefined)).toBe(false);
  });
});

describe("rollEffectsAllowed", () => {
  it("skips rattle and haptic when the reader prefers reduced motion", () => {
    expect(rollEffectsAllowed(true, true)).toEqual({ rattle: false, haptic: false });
  });

  it("keeps the rattle when vibration is missing, and drops only the haptic", () => {
    expect(rollEffectsAllowed(false, false)).toEqual({ rattle: true, haptic: false });
    expect(rollEffectsAllowed(false, true)).toEqual({ rattle: true, haptic: true });
  });
});
