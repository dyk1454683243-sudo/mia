/**
 * Which vibration to play, and whether this browser should play one at all.
 *
 * Pure on purpose: `client/src/table.ts` cannot be imported under Node, and
 * `navigator.vibrate` is a browser call. The patterns, the preference parse
 * and the reduced-motion gate live here so the `unit` project can pin them.
 *
 * Haptics are on by default — phones in pockets need them more than they need
 * the countdown. Only the literal `"off"` opts out; that is the hook a later
 * toggle (or the sound toggle, if that item has landed) writes through.
 * `prefers-reduced-motion: reduce` is a hard no either way.
 */
import type { TableCue } from "./table-cues";

/** The three personal events. `reveal` is table-wide and stays silent here. */
export type HapticCue = "your-turn" | "doubted" | "life-lost";

export const HAPTICS_STORAGE_KEY = "mia_haptics";

/** One short tap — the cup reached you. */
export const TAP_MS = 20;
/** Gap between the two taps of a double. */
export const DOUBLE_GAP_MS = 40;
/** Longer pulse when a life comes off. A buzz, not a rumble. */
export const LIFE_LOST_MS = 80;

export const HAPTIC_PATTERN: Record<HapticCue, readonly number[]> = {
  "your-turn": [TAP_MS],
  doubted: [TAP_MS, DOUBLE_GAP_MS, TAP_MS],
  "life-lost": [LIFE_LOST_MS],
};

/**
 * On unless the stored value is exactly `"off"`. A missing key, a typo, or
 * a boolean-looking string cannot silence the phone — the opposite of sound,
 * which is off unless the stored value is exactly `"on"`.
 */
export function isHapticsOn(raw: string | null): boolean {
  return raw !== "off";
}

/** What a future toggle writes. Never a boolean string. */
export function hapticsStorageValue(on: boolean): "on" | "off" {
  return on ? "on" : "off";
}

/**
 * Reduced motion wins. An explicit off wins. Missing or unknown pref is on.
 */
export function hapticsAllowed(reducedMotion: boolean, prefOn: boolean): boolean {
  return !reducedMotion && prefOn;
}

/**
 * One cue per snapshot. A caught bluff emits `doubted` and `life-lost`
 * together; `navigator.vibrate` replaces the current pattern, so two calls
 * would cancel. The life is the one that matters in a pocket.
 */
export function pickHapticCue(cues: readonly TableCue[]): HapticCue | null {
  if (cues.includes("life-lost")) return "life-lost";
  if (cues.includes("doubted")) return "doubted";
  if (cues.includes("your-turn")) return "your-turn";
  return null;
}

export function hapticPatternFor(cue: HapticCue): number[] {
  return HAPTIC_PATTERN[cue].slice();
}

/**
 * Feature-detect lives in the `vibrate` callback — iOS Safari has no
 * `navigator.vibrate`, and Chrome no-ops until a user gesture. This function
 * never touches the browser itself.
 */
export function playHapticCues(
  cues: readonly TableCue[],
  opts: {
    reducedMotion: boolean;
    prefOn: boolean;
    vibrate: (pattern: number[]) => boolean;
  },
): HapticCue | null {
  if (!hapticsAllowed(opts.reducedMotion, opts.prefOn)) return null;
  const cue = pickHapticCue(cues);
  if (cue === null) return null;
  opts.vibrate(hapticPatternFor(cue));
  return cue;
}
