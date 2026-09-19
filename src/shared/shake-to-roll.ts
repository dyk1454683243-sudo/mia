/**
 * Shake-to-roll and Space-to-roll, as pure decisions.
 *
 * The browser wires `devicemotion` and the Space key; this module is what
 * decides whether a sample is a shake, whether that shake (or a key) may
 * send, and which of `roll` / `believe` it becomes. Keeping the arithmetic
 * here means walking-vs-shake, the one-roll-per-turn gate and the iOS
 * "do not ask on load" rule can be pinned under Node. `client/src/table.ts`
 * cannot — it queries `#app` at module scope.
 *
 * The send itself stays in the page. A gesture that built its own message
 * would miss the stale-move stamp `TableSocket` relies on.
 */

/** User-acceleration magnitude that counts as a shake peak, in m/s². */
export const SHAKE_THRESHOLD_MS2 = 16;
/** Softer floor for the optional rattle, well below a committed shake. */
export const RATTLE_THRESHOLD_MS2 = 7;
/** Distinct peaks inside the window before one shake fires. */
export const SHAKE_MIN_PEAKS = 3;
/** How long a cluster of peaks may span and still be one shake. */
export const SHAKE_WINDOW_MS = 450;
/** Ignore a second crossing that is just the same spike sampled twice. */
export const SHAKE_MIN_PEAK_GAP_MS = 70;
/** After a fire, refuse another shake so one gesture cannot spam. */
export const SHAKE_COOLDOWN_MS = 900;
/** Earth gravity, used only when the event has no user-acceleration axes. */
export const GRAVITY_MS2 = 9.80665;

export interface MotionAxes {
  x: number | null;
  y: number | null;
  z: number | null;
}

export interface MotionReading {
  acceleration: MotionAxes | null;
  accelerationIncludingGravity: MotionAxes | null;
}

export type GestureRoll = "roll" | "believe";

export interface LegalRollMoves {
  canRoll: boolean;
  canBelieve: boolean;
}

export interface ShakeSample {
  shake: boolean;
  rattling: boolean;
}

export type MotionListenPlan = "listen" | "wait-for-gesture" | "none";

/**
 * Magnitude of the user's acceleration, or null when the event has no
 * usable axes (permission denied, no hardware, or a still-empty sample).
 *
 * Prefer `acceleration` (gravity already removed). A device that only
 * fills `accelerationIncludingGravity` is reduced against 1g so a phone
 * sitting on a table is ~0, not ~9.8. Exact-zero user axes are treated
 * as "not provided": several browsers report `{0,0,0}` when the field
 * is unsupported, and a real still phone jitters above that.
 */
export function motionMagnitude(reading: MotionReading): number | null {
  const user = axesMagnitude(reading.acceleration);
  if (user !== null && user > 0.01) return user;
  const withGravity = axesMagnitude(reading.accelerationIncludingGravity);
  if (withGravity === null) return user === 0 ? 0 : null;
  return Math.abs(withGravity - GRAVITY_MS2);
}

function axesMagnitude(axes: MotionAxes | null): number | null {
  if (!axes) return null;
  const { x, y, z } = axes;
  if (x === null || y === null || z === null) return null;
  return Math.hypot(x, y, z);
}

/**
 * Walking is a few m/s². A committed shake has to cross the threshold
 * several times inside a short window, with a gap between peaks so one
 * sample burst is not three peaks. After a fire the detector goes quiet
 * for `SHAKE_COOLDOWN_MS` — the server would reject a second roll on the
 * same turn, but the client should not send it.
 */
export class ShakeDetector {
  #peaks: number[] = [];
  #lastPeakAt = Number.NEGATIVE_INFINITY;
  #cooldownUntil = 0;

  sample(magnitude: number | null, now: number): ShakeSample {
    if (magnitude === null) {
      return { shake: false, rattling: false };
    }
    if (now < this.#cooldownUntil) {
      return { shake: false, rattling: false };
    }

    this.#peaks = this.#peaks.filter((at) => now - at <= SHAKE_WINDOW_MS);
    if (magnitude >= SHAKE_THRESHOLD_MS2 && now - this.#lastPeakAt >= SHAKE_MIN_PEAK_GAP_MS) {
      this.#peaks.push(now);
      this.#lastPeakAt = now;
    }

    if (this.#peaks.length >= SHAKE_MIN_PEAKS) {
      this.#peaks = [];
      this.#lastPeakAt = now;
      this.#cooldownUntil = now + SHAKE_COOLDOWN_MS;
      return { shake: true, rattling: false };
    }

    return { shake: false, rattling: magnitude >= RATTLE_THRESHOLD_MS2 };
  }

  reset(): void {
    this.#peaks = [];
    this.#lastPeakAt = Number.NEGATIVE_INFINITY;
    this.#cooldownUntil = 0;
  }
}

/**
 * The same action the visible button would send. `canRoll` and
 * `canBelieve` are mutually exclusive in the engine; believe is named
 * first so a future overlap cannot silently pick the opener.
 */
export function gestureRollAction(moves: LegalRollMoves): GestureRoll | null {
  if (moves.canBelieve) return "believe";
  if (moves.canRoll) return "roll";
  return null;
}

/**
 * One client-side roll per `logSeq`. The stamp on the message is the
 * snapshot the player decided against; sending a second roll against the
 * same sequence is the spam the server already refuses.
 */
export function shouldSendRoll(alreadySentFor: number | null, logSeq: number): boolean {
  return alreadySentFor !== logSeq;
}

export function spaceIsRollKey(key: string): boolean {
  return key === " " || key === "Spacebar";
}

/**
 * Space is the desktop shake, but it is also the native activator for a
 * focused button. A focused Doubt (or any other control) keeps its own
 * Space; a focused Roll / Believe, or no control at all, is a roll.
 */
export function spaceShouldRoll(event: {
  key: string;
  repeat: boolean;
  editing: boolean;
  focusedAction: string | null;
}): boolean {
  if (event.repeat) return false;
  if (!spaceIsRollKey(event.key)) return false;
  if (event.editing) return false;
  if (event.focusedAction !== null && event.focusedAction !== "roll" && event.focusedAction !== "believe") {
    return false;
  }
  return true;
}

/**
 * iOS 13+ only delivers motion after `requestPermission`, and that call
 * is denied by reflex if it runs on load. Android has no such prompt.
 * "none" is a laptop: no listener, no prompt, the tap path is the game.
 */
export function motionListenPlan(hasDeviceMotion: boolean, needsPermission: boolean): MotionListenPlan {
  if (!hasDeviceMotion) return "none";
  if (needsPermission) return "wait-for-gesture";
  return "listen";
}

export function deviceMotionNeedsPermission(ctor: unknown): boolean {
  return (
    typeof ctor === "function" &&
    typeof (ctor as { requestPermission?: unknown }).requestPermission === "function"
  );
}

/**
 * Rattle and the settle haptic are accelerators on the feel, not the
 * rules. Reduced motion turns both off; a missing Vibration API turns
 * only the haptic off. The tap path never consults this.
 */
export function rollEffectsAllowed(
  reducedMotion: boolean,
  vibrateAvailable: boolean,
): { rattle: boolean; haptic: boolean } {
  if (reducedMotion) return { rattle: false, haptic: false };
  return { rattle: true, haptic: vibrateAvailable };
}
