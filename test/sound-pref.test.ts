/**
 * The sound preference is off unless the stored value is exactly `"on"`. That
 * is the whole feature's safety: a missing key, a typo, or a boolean-looking
 * string must not turn the speakers on.
 */
import { describe, expect, it } from "vitest";
import { isSoundOn, SOUND_STORAGE_KEY, soundStorageValue } from "../src/shared/sound-pref";

describe("sound preference", () => {
  it("uses a stable localStorage key", () => {
    expect(SOUND_STORAGE_KEY).toBe("mia_sound");
  });

  it("is off for every value that is not the literal on", () => {
    expect(isSoundOn(null)).toBe(false);
    expect(isSoundOn("")).toBe(false);
    expect(isSoundOn("off")).toBe(false);
    expect(isSoundOn("true")).toBe(false);
    expect(isSoundOn("1")).toBe(false);
    expect(isSoundOn("ON")).toBe(false);
    expect(isSoundOn("on ")).toBe(false);
  });

  it("is on only for the literal on", () => {
    expect(isSoundOn("on")).toBe(true);
  });

  it("writes on and off, never a boolean string", () => {
    expect(soundStorageValue(true)).toBe("on");
    expect(soundStorageValue(false)).toBe("off");
  });
});
