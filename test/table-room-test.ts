/**
 * The `TableRoom` the workers tests drive: the production class plus the seams a
 * test needs. It is deliberately *not* exported from the Worker entrypoint
 * (`src/worker/index.ts`), so the deployed bundle contains no way to force dice
 * into a game or read unredacted state.
 */
import { playerById, type Die, type MiaState, type Timings } from "../src/shared/mia";
import { TableRoom } from "../src/worker/table-room";

export class TestTableRoom extends TableRoom {
  private resultWriteFailures = 0;

  /**
   * Force the dice in front of a player, so a table can be driven through a
   * specific bluff or a real Mia. Production never does this — every other
   * route into the state rolls real dice.
   */
  async __setDiceForTest(playerId: string, dice: [Die, Die]): Promise<MiaState> {
    const state = this.state;
    if (state === null) throw new Error("no game state");
    const next = structuredClone(state);
    const player = playerById(next, playerId);
    if (!player) throw new Error("unknown player");
    player.dice = dice;
    next.diceOwnerId = playerId;
    await this.commit(next);
    return next;
  }

  /** Read the unredacted server-side state. */
  async __stateForTest(): Promise<MiaState | null> {
    return this.state;
  }

  /** Shorten the clock so timers can be exercised in milliseconds. */
  async __setTimingsForTest(timings: Timings): Promise<void> {
    this.timings = timings;
  }

  /** Arm the next `times` result writes to fail, like a flaky D1. */
  async __failResultWritesForTest(times: number): Promise<void> {
    this.resultWriteFailures = times;
  }

  /** How many times this room has attempted the D1 result write. */
  async __resultWriteAttemptsForTest(): Promise<number> {
    return this.resultWriteAttempts;
  }

  protected override shouldFailResultWrite(): boolean {
    if (this.resultWriteFailures > 0) {
      this.resultWriteFailures -= 1;
      return true;
    }
    return false;
  }
}
