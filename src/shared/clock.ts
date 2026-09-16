/**
 * Turn-countdown arithmetic for the client. Pure, with no DOM or Cloudflare
 * dependency, so it runs in plain Node under vitest.
 *
 * The subtlety worth stating: where the clock offset is measured. `sync` takes
 * it once per server snapshot; re-deriving it on every tick would cancel out
 * the elapsed time — `deadline - (now - (now - serverTime))` is just
 * `deadline - serverTime` — and freeze the displayed value between broadcasts.
 * That was the countdown bug this replaced.
 */
export class TurnClock {
  /** Client clock minus server clock, from the most recent snapshot. */
  private drift = 0;

  /** Capture the clock offset. Call this once per server snapshot. */
  sync(serverTime: number, now = Date.now()): void {
    this.drift = now - serverTime;
  }

  /** Seconds until `deadlineAt` against the live client clock, or null. */
  secondsLeft(deadlineAt: number | null, now = Date.now()): number | null {
    if (deadlineAt === null) return null;
    return Math.max(0, Math.ceil((deadlineAt - (now - this.drift)) / 1000));
  }

  /**
   * The same live clock expressed in server time, for callers that need an
   * instant rather than a whole-second countdown. The showdown uses it to place
   * a rebuilt subtree at the frame the animation had already reached, using the
   * one drift measurement `sync` captured.
   */
  now(now = Date.now()): number {
    return now - this.drift;
  }
}
