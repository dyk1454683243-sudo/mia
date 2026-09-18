/**
 * Haptics are the personal three cues, on by default, silent under reduced
 * motion or an explicit off. `navigator.vibrate` is a browser call; the
 * patterns and the gates are what this file pins.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DOUBLE_GAP_MS,
  hapticPatternFor,
  hapticsAllowed,
  hapticsStorageValue,
  HAPTICS_STORAGE_KEY,
  isHapticsOn,
  LIFE_LOST_MS,
  pickHapticCue,
  playHapticCues,
  TAP_MS,
} from "../src/shared/haptics";

describe("haptics preference", () => {
  it("uses a stable localStorage key", () => {
    expect(HAPTICS_STORAGE_KEY).toBe("mia_haptics");
  });

  it("is on for every value that is not the literal off", () => {
    expect(isHapticsOn(null)).toBe(true);
    expect(isHapticsOn("")).toBe(true);
    expect(isHapticsOn("on")).toBe(true);
    expect(isHapticsOn("true")).toBe(true);
    expect(isHapticsOn("1")).toBe(true);
    expect(isHapticsOn("OFF")).toBe(true);
    expect(isHapticsOn("off ")).toBe(true);
  });

  it("is off only for the literal off", () => {
    expect(isHapticsOn("off")).toBe(false);
  });

  it("writes on and off, never a boolean string", () => {
    expect(hapticsStorageValue(true)).toBe("on");
    expect(hapticsStorageValue(false)).toBe("off");
  });
});

describe("hapticsAllowed", () => {
  it("is on by default", () => {
    expect(hapticsAllowed(false, true)).toBe(true);
  });

  it("is silent when the reader prefers reduced motion", () => {
    expect(hapticsAllowed(true, true)).toBe(false);
    expect(hapticsAllowed(true, false)).toBe(false);
  });

  it("is silent when the stored preference is off", () => {
    expect(hapticsAllowed(false, false)).toBe(false);
  });
});

describe("pickHapticCue", () => {
  it("maps the personal three and ignores reveal", () => {
    expect(pickHapticCue(["your-turn"])).toBe("your-turn");
    expect(pickHapticCue(["doubted"])).toBe("doubted");
    expect(pickHapticCue(["life-lost"])).toBe("life-lost");
    expect(pickHapticCue(["reveal"])).toBeNull();
    expect(pickHapticCue([])).toBeNull();
  });

  it("prefers the lost life when a caught bluff emits both personal cues", () => {
    expect(pickHapticCue(["doubted", "life-lost", "reveal"])).toBe("life-lost");
  });

  it("still buzzes a doubt that did not cost this viewer a life", () => {
    expect(pickHapticCue(["doubted", "reveal"])).toBe("doubted");
  });
});

describe("hapticPatternFor", () => {
  it("is one short tap, a double, or a longer buzz", () => {
    expect(hapticPatternFor("your-turn")).toEqual([TAP_MS]);
    expect(hapticPatternFor("doubted")).toEqual([TAP_MS, DOUBLE_GAP_MS, TAP_MS]);
    expect(hapticPatternFor("life-lost")).toEqual([LIFE_LOST_MS]);
  });

  it("returns a copy so a caller cannot mutate the table", () => {
    const pattern = hapticPatternFor("your-turn");
    pattern[0] = 999;
    expect(hapticPatternFor("your-turn")).toEqual([TAP_MS]);
  });
});

describe("playHapticCues", () => {
  it("vibrates the chosen pattern when allowed", () => {
    const vibrate = vi.fn(() => true);
    expect(
      playHapticCues(["your-turn"], { reducedMotion: false, prefOn: true, vibrate }),
    ).toBe("your-turn");
    expect(vibrate).toHaveBeenCalledOnce();
    expect(vibrate).toHaveBeenCalledWith([TAP_MS]);
  });

  it("does not vibrate on the first snapshot or a reconnect (empty cues)", () => {
    const vibrate = vi.fn(() => true);
    expect(playHapticCues([], { reducedMotion: false, prefOn: true, vibrate })).toBeNull();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("does not vibrate under reduced motion", () => {
    const vibrate = vi.fn(() => true);
    expect(
      playHapticCues(["life-lost"], { reducedMotion: true, prefOn: true, vibrate }),
    ).toBeNull();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("does not vibrate when the preference is off", () => {
    const vibrate = vi.fn(() => true);
    expect(
      playHapticCues(["doubted"], { reducedMotion: false, prefOn: false, vibrate }),
    ).toBeNull();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("does not vibrate a table-wide reveal that is not personal", () => {
    const vibrate = vi.fn(() => true);
    expect(playHapticCues(["reveal"], { reducedMotion: false, prefOn: true, vibrate })).toBeNull();
    expect(vibrate).not.toHaveBeenCalled();
  });
});
