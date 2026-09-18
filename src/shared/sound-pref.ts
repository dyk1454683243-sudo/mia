/**
 * The sound preference is a browser setting, not a seat setting: it lives in
 * `localStorage` and never reaches the server. Only the literal `"on"` enables
 * it, so a missing key, a typo, or a future value cannot turn the speakers on
 * in a room where everyone's phone is out.
 */
export const SOUND_STORAGE_KEY = "mia_sound";

export function isSoundOn(raw: string | null): boolean {
  return raw === "on";
}

export function soundStorageValue(on: boolean): "on" | "off" {
  return on ? "on" : "off";
}
