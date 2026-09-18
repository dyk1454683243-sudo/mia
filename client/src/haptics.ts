/**
 * Browser adapter for the table's three vibrations. The patterns and the
 * gates live in `src/shared/haptics.ts`; this file is the feature-detected
 * `navigator.vibrate` call and the two preference reads the page cannot
 * unit-test (matchMedia, localStorage).
 *
 * iOS Safari has no `vibrate`. Chrome no-ops until a user has tapped. Both
 * are fine: the call is always guarded, and a no-op is not an error.
 */
import { HAPTICS_STORAGE_KEY, isHapticsOn, playHapticCues } from "../../src/shared/haptics";
import type { TableCue } from "../../src/shared/table-cues";

function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function readHapticsRaw(): string | null {
  try {
    return localStorage.getItem(HAPTICS_STORAGE_KEY);
  } catch {
    // Private mode: treat as unset, which is on.
    return null;
  }
}

/**
 * The only call site that touches `navigator.vibrate`. Feature-detect first;
 * catch in case a browser exposes the function and then throws.
 */
function vibrate(pattern: number[]): boolean {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
    return false;
  }
  try {
    return navigator.vibrate(pattern);
  } catch {
    return false;
  }
}

/** Play the personal cues from one snapshot transition. `reveal` is ignored. */
export function fireTableHaptics(cues: TableCue[]): void {
  playHapticCues(cues, {
    reducedMotion: prefersReducedMotion(),
    prefOn: isHapticsOn(readHapticsRaw()),
    vibrate,
  });
}
