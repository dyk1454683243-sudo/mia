/**
 * Pure rules-engine tests. No Workers runtime needed.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_VALUES,
  applyAction,
  autoPlaySequence,
  beginRoundPlay,
  buildView,
  createGameState,
  finalStandings,
  formatValue,
  isRankedValue,
  legalAnnouncements,
  legalMoves,
  MIA,
  minimumAnnouncement,
  outranks,
  playerById,
  RANKING,
  resolveReveal,
  rollDice,
  rollValue,
  STARTING_LIVES,
  type Die,
  type MiaState,
} from "../src/shared/mia";

const TIMINGS = { turnMs: 60_000, revealMs: 5_000, roundStartMs: 2_000 };
const T0 = 1_700_000_000_000;

function seats(...names: string[]): { id: string; name: string }[] {
  return names.map((name) => ({ id: name.toLowerCase(), name }));
}

/** A game whose first round is already in play, so actions can be applied. */
function playing(...names: string[]): MiaState {
  const state = createGameState("t1", "Test table", seats(...names), T0);
  beginRoundPlay(state, TIMINGS, T0);
  return state;
}

function must(result: ReturnType<typeof applyAction>): MiaState {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.state;
}

function fails(result: ReturnType<typeof applyAction>): string {
  if (result.ok) throw new Error("expected failure, but the action was accepted");
  return result.error.code;
}

/** Roll as `playerId`, then force the dice to a known pair. */
function rollAs(state: MiaState, playerId: string, dice: [Die, Die], at = T0): MiaState {
  const rolled = must(applyAction(state, { type: "roll", playerId }, TIMINGS, at));
  const player = playerById(rolled, playerId)!;
  player.dice = dice;
  return rolled;
}

function announce(state: MiaState, playerId: string, value: number, at = T0): MiaState {
  return must(applyAction(state, { type: "announce", playerId, value }, TIMINGS, at));
}

describe("ranking", () => {
  it("hardcodes the exact ranking order, highest to lowest", () => {
    expect(RANKING).toEqual([
      21, 66, 55, 44, 33, 22, 11, 65, 64, 63, 62, 61, 54, 53, 52, 51, 43, 42, 41, 32, 31,
    ]);
    expect(ALL_VALUES).toHaveLength(21);
    expect(new Set(ALL_VALUES).size).toBe(21);
  });

  it("orders every pair strictly, with Mia on top", () => {
    for (let i = 0; i < RANKING.length; i++) {
      for (let j = 0; j < RANKING.length; j++) {
        const a = RANKING[i]!;
        const b = RANKING[j]!;
        if (i < j) expect(outranks(a, b), `${a} should beat ${b}`).toBe(true);
        else expect(outranks(a, b), `${a} should not beat ${b}`).toBe(false);
      }
    }
    expect(outranks(MIA, MIA)).toBe(false);
  });

  it("ranks doubles above every mixed roll", () => {
    const doubles = [66, 55, 44, 33, 22, 11];
    const mixed = RANKING.filter((value) => !doubles.includes(value) && value !== MIA);
    for (const double of doubles) {
      for (const other of mixed) {
        expect(outranks(double, other), `${double} should beat ${other}`).toBe(true);
      }
    }
  });

  it("computes roll values as higher x 10 + lower", () => {
    expect(rollValue(6, 3)).toBe(63);
    expect(rollValue(3, 6)).toBe(63);
    expect(rollValue(2, 1)).toBe(MIA);
    expect(rollValue(1, 2)).toBe(MIA);
    expect(rollValue(4, 4)).toBe(44);
    for (let a = 1 as Die; a <= 6; a++) {
      for (let b = 1 as Die; b <= 6; b++) {
        expect(isRankedValue(rollValue(a, b))).toBe(true);
      }
    }
  });

  it("rolls only real dice", () => {
    for (let i = 0; i < 500; i++) {
      const [a, b] = rollDice();
      expect(a).toBeGreaterThanOrEqual(1);
      expect(a).toBeLessThanOrEqual(6);
      expect(b).toBeGreaterThanOrEqual(1);
      expect(b).toBeLessThanOrEqual(6);
    }
  });

  it("labels values readably", () => {
    expect(formatValue(21)).toBe("2·1");
    expect(formatValue(53)).toBe("5·3");
  });
});

describe("legal announcements", () => {
  it("allows everything when nothing stands", () => {
    expect(legalAnnouncements(null)).toEqual([...RANKING]);
  });

  it("allows only strictly higher values above a standing announcement", () => {
    // Highest-ranked first. A 65 is beaten only by 21, 66, and the five lower
    // doubles; a 31 is the worst roll in the game, so everything beats it.
    expect(legalAnnouncements(65)).toEqual([21, 66, 55, 44, 33, 22, 11]);
    expect(legalAnnouncements(22)).toEqual([21, 66, 55, 44, 33]);
    expect(legalAnnouncements(31)).toEqual(RANKING.filter((value) => value !== 31));
    expect(legalAnnouncements(MIA)).toEqual([]);
  });

  it("finds the minimum legal announcement", () => {
    expect(minimumAnnouncement(null)).toBe(31);
    expect(minimumAnnouncement(31)).toBe(32);
    expect(minimumAnnouncement(22)).toBe(33);
    expect(minimumAnnouncement(65)).toBe(11);
    expect(minimumAnnouncement(MIA)).toBeNull();
  });
});

describe("turn flow", () => {
  it("starts in a round-start beat, then asks the first player to open", () => {
    const state = createGameState("t1", "Test table", seats("anna", "bo"), T0);
    expect(state.phase).toBe("roundStart");
    expect(state.round).toBe(1);
    expect(state.turnPlayerId).toBe("anna");
    beginRoundPlay(state, TIMINGS, T0);
    expect(state.phase).toBe("deciding");
    // Nothing stands and no dice are out, so the opener must roll.
    const moves = legalMoves(state, "anna");
    expect(moves.canRoll).toBe(true);
    expect(moves.canBelieve).toBe(false);
    expect(moves.canDoubt).toBe(false);
  });

  it("rejects actions from the wrong player", () => {
    const state = playing("anna", "bo");
    expect(fails(applyAction(state, { type: "roll", playerId: "bo" }, TIMINGS, T0))).toBe("not-your-turn");
    expect(fails(applyAction(state, { type: "announce", playerId: "bo", value: 31 }, TIMINGS, T0))).toBe("not-your-turn");
  });

  it("rejects unknown players and unknown values", () => {
    const state = playing("anna", "bo");
    expect(fails(applyAction(state, { type: "roll", playerId: "zoe" }, TIMINGS, T0))).toBe("unknown-player");
    const rolled = rollAs(state, "anna", [3, 1]);
    expect(fails(applyAction(rolled, { type: "announce", playerId: "anna", value: 99 }, TIMINGS, T0))).toBe(
      "unknown-value",
    );
    expect(fails(applyAction(rolled, { type: "announce", playerId: "anna", value: 47 }, TIMINGS, T0))).toBe(
      "unknown-value",
    );
    // A real roll, just not one that exists above nothing: the opener may claim it.
    expect(must(applyAction(rolled, { type: "announce", playerId: "anna", value: 31 }, TIMINGS, T0)).lastAnnouncement?.value).toBe(31);
  });

  it("requires a strictly higher announcement", () => {
    let state = playing("anna", "bo");
    state = rollAs(state, "anna", [6, 3]); // 63
    state = announce(state, "anna", 53);
    // bo believes, rolls a weak hand, and must now claim something higher.
    state = must(applyAction(state, { type: "believe", playerId: "bo" }, TIMINGS, T0));
    playerById(state, "bo")!.dice = [1, 1];
    expect(fails(applyAction(state, { type: "announce", playerId: "bo", value: 53 }, TIMINGS, T0))).toBe(
      "illegal-announcement",
    );
    expect(fails(applyAction(state, { type: "announce", playerId: "bo", value: 52 }, TIMINGS, T0))).toBe(
      "illegal-announcement",
    );
    const ok = announce(state, "bo", 54);
    expect(ok.lastAnnouncement?.value).toBe(54);
    expect(ok.lastAnnouncement?.playerName).toBe("bo");
  });

  it("refuses to announce before rolling", () => {
    const state = playing("anna", "bo");
    expect(fails(applyAction(state, { type: "announce", playerId: "anna", value: 31 }, TIMINGS, T0))).toBe(
      "wrong-phase",
    );
  });

  it("will not let the opener believe a claim that does not exist", () => {
    const state = playing("anna", "bo");
    expect(fails(applyAction(state, { type: "believe", playerId: "anna" }, TIMINGS, T0))).toBe("wrong-phase");
    expect(fails(applyAction(state, { type: "doubt", playerId: "anna" }, TIMINGS, T0))).toBe("nothing-to-doubt");
  });

  it("hands the turn to the next living player", () => {
    let state = playing("anna", "bo", "cara");
    state = rollAs(state, "anna", [5, 5]);
    state = announce(state, "anna", 21);
    expect(state.turnPlayerId).toBe("bo");
  });

  it("forces a doubt when nothing outranks the standing Mia", () => {
    let state = playing("anna", "bo");
    state = rollAs(state, "anna", [2, 1]);
    state = announce(state, "anna", MIA);
    // bo cannot claim anything higher than Mia, so doubt is the only legal move.
    const moves = legalMoves(state, "bo");
    expect(moves.canAnnounce).toBe(false);
    expect(moves.canBelieve).toBe(false);
    expect(moves.canDoubt).toBe(true);
    // A roll here would leave bo holding the cup with no legal announcement —
    // the state the server must never accept, whatever the client sends.
    expect(moves.canRoll).toBe(false);
    expect(fails(applyAction(state, { type: "roll", playerId: "bo" }, TIMINGS, T0))).toBe("wrong-phase");
  });

  it("does not offer a roll once anything stands", () => {
    let state = playing("anna", "bo");
    state = rollAs(state, "anna", [6, 1]);
    state = announce(state, "anna", 31);
    const moves = legalMoves(state, "bo");
    expect(moves.canRoll).toBe(false);
    expect(moves.canBelieve).toBe(true);
    expect(fails(applyAction(state, { type: "roll", playerId: "bo" }, TIMINGS, T0))).toBe("wrong-phase");
  });
});

describe("doubt resolution", () => {
  /**
   * anna opens with `annaDice` and claims `annaClaim`; bo believes, holds
   * `boDice` and claims `boClaim`, which must outrank `annaClaim`; then `doubter`
   * calls the doubt on the claim bo just made.
   */
  function chain(options: {
    annaDice: [Die, Die];
    annaClaim: number;
    boDice: [Die, Die];
    boClaim: number;
    doubter: "anna" | "bo";
  }): MiaState {
    let state = playing("anna", "bo");
    state = rollAs(state, "anna", options.annaDice);
    state = announce(state, "anna", options.annaClaim);
    state = must(applyAction(state, { type: "believe", playerId: "bo" }, TIMINGS, T0));
    playerById(state, "bo")!.dice = options.boDice;
    state = announce(state, "bo", options.boClaim);
    return must(applyAction(state, { type: "doubt", playerId: options.doubter }, TIMINGS, T0));
  }

  it("catches the first announcer's bluff and charges them", () => {
    // anna opens claiming 65 on a 63 — worse than she said, so bo's doubt is right.
    let state = playing("anna", "bo");
    state = rollAs(state, "anna", [6, 3]);
    state = announce(state, "anna", 65);
    state = must(applyAction(state, { type: "doubt", playerId: "bo" }, TIMINGS, T0));

    expect(state.phase).toBe("revealing");
    expect(state.pendingDoubt?.verdict).toBe("announcer");
    expect(state.pendingDoubt?.actual).toBe(63);
    expect(state.pendingDoubt?.announced).toBe(65);
    expect(playerById(state, "anna")!.lives).toBe(STARTING_LIVES - 1);
    expect(playerById(state, "bo")!.lives).toBe(STARTING_LIVES);
    // The player who lost the life starts the next round.
    expect(state.nextStarterId).toBe("anna");
  });

  it("costs the doubter a life when the announcement was honest enough", () => {
    // anna claims 52 on a 65 — better than she said, so bo's doubt was a mistake.
    let state = playing("anna", "bo");
    state = rollAs(state, "anna", [6, 5]);
    state = announce(state, "anna", 52);
    state = must(applyAction(state, { type: "doubt", playerId: "bo" }, TIMINGS, T0));

    expect(state.pendingDoubt?.verdict).toBe("doubter");
    expect(state.pendingDoubt?.actual).toBe(65);
    expect(playerById(state, "anna")!.lives).toBe(STARTING_LIVES);
    expect(playerById(state, "bo")!.lives).toBe(STARTING_LIVES - 1);
    expect(state.nextStarterId).toBe("bo");
  });

  it("catches the second announcer's bluff and charges them", () => {
    // anna honest (65 on 65), bo bluffs 66 on a 31 and is called by anna.
    const state = chain({
      annaDice: [6, 5],
      annaClaim: 65,
      boDice: [3, 1],
      boClaim: 66,
      doubter: "anna",
    });

    expect(state.pendingDoubt?.verdict).toBe("announcer");
    expect(state.pendingDoubt?.actual).toBe(31);
    expect(playerById(state, "bo")!.lives).toBe(STARTING_LIVES - 1);
    expect(state.nextStarterId).toBe("bo");
  });

  it("costs a doubter two lives for doubting a real Mia", () => {
    let state = playing("anna", "bo");
    state = rollAs(state, "anna", [2, 1]); // a genuine Mia
    state = announce(state, "anna", MIA);
    state = must(applyAction(state, { type: "doubt", playerId: "bo" }, TIMINGS, T0));

    expect(state.pendingDoubt?.penaltyApplied).toBe("double-mia");
    expect(state.pendingDoubt?.verdict).toBe("doubter");
    expect(playerById(state, "bo")!.lives).toBe(STARTING_LIVES - 2);
    expect(state.lastLoss?.lives).toBe(2);
  });

  it("charges the single penalty for a caught bluffed Mia", () => {
    // anna claims Mia. The actual roll of 66 still loses to a real Mia, so the
    // claim was a bluff and bo's doubt is right. Three players so that somebody
    // is left to make the call.
    let state = playing("anna", "bo", "cara");
    state = rollAs(state, "anna", [6, 6]);
    state = announce(state, "anna", MIA);
    state = must(applyAction(state, { type: "doubt", playerId: "bo" }, TIMINGS, T0));

    expect(state.pendingDoubt?.penaltyApplied).toBe("single");
    expect(state.pendingDoubt?.verdict).toBe("announcer");
    expect(state.pendingDoubt?.actual).toBe(66);
    expect(playerById(state, "anna")!.lives).toBe(STARTING_LIVES - 1);
    expect(playerById(state, "bo")!.lives).toBe(STARTING_LIVES);
  });

  it("lets a double-6 stand against a claimed 65", () => {
    // Rank ordering, not arithmetic: 66 outranks 65, so doubting it costs the
    // doubter a life even though the claim was a bluff.
    let state = playing("anna", "bo");
    state = rollAs(state, "anna", [6, 6]);
    state = announce(state, "anna", 65);
    state = must(applyAction(state, { type: "doubt", playerId: "bo" }, TIMINGS, T0));

    expect(state.pendingDoubt?.actual).toBe(66);
    expect(state.pendingDoubt?.verdict).toBe("doubter");
    expect(playerById(state, "bo")!.lives).toBe(STARTING_LIVES - 1);
  });
});

describe("rounds, elimination and winning", () => {
  it("starts the next round with the player who lost the life", () => {
    let state = playing("anna", "bo", "cara");
    state = rollAs(state, "anna", [6, 6]);
    state = announce(state, "anna", 52);
    state = must(applyAction(state, { type: "believe", playerId: "bo" }, TIMINGS, T0));
    playerById(state, "bo")!.dice = [3, 1]; // actual 31
    state = announce(state, "bo", 63); // bluffing 63
    state = must(applyAction(state, { type: "doubt", playerId: "cara" }, TIMINGS, T0));

    expect(state.pendingDoubt?.verdict).toBe("announcer");
    expect(playerById(state, "bo")!.lives).toBe(STARTING_LIVES - 1);

    const next = resolveReveal(state, TIMINGS, T0 + 5_000);
    expect(next.round).toBe(2);
    expect(next.turnPlayerId).toBe("bo");
    expect(next.diceOwnerId).toBeNull();
    expect(next.lastAnnouncement).toBeNull();
    expect(next.players.every((player) => player.dice === null)).toBe(true);
    expect(next.players.every((player) => player.roundsPlayed === 2)).toBe(true);
  });

  it("passes the opening turn on when the life loss eliminated them", () => {
    let state = playing("anna", "bo", "cara");
    playerById(state, "bo")!.lives = 1;
    state = rollAs(state, "anna", [6, 6]);
    state = announce(state, "anna", 52);
    state = must(applyAction(state, { type: "believe", playerId: "bo" }, TIMINGS, T0));
    playerById(state, "bo")!.dice = [3, 1];
    state = announce(state, "bo", 63);
    state = must(applyAction(state, { type: "doubt", playerId: "cara" }, TIMINGS, T0));

    expect(playerById(state, "bo")!.eliminated).toBe(true);
    expect(playerById(state, "bo")!.lives).toBe(0);
    const next = resolveReveal(state, TIMINGS, T0 + 5_000);
    expect(next.gameOver).toBeNull();
    expect(next.round).toBe(2);
    // bo is gone, so the seat after bo opens the round.
    expect(next.turnPlayerId).toBe("cara");
  });

  it("detects a win when only one player is left standing", () => {
    let state = playing("anna", "bo");
    playerById(state, "bo")!.lives = 1;
    state = rollAs(state, "anna", [6, 6]);
    state = announce(state, "anna", 52);
    state = must(applyAction(state, { type: "believe", playerId: "bo" }, TIMINGS, T0));
    playerById(state, "bo")!.dice = [3, 1];
    state = announce(state, "bo", 63);
    state = must(applyAction(state, { type: "doubt", playerId: "anna" }, TIMINGS, T0));

    expect(state.gameOver?.winnerId).toBe("anna");
    expect(state.gameOver?.winnerName).toBe("anna");
    expect(state.phase).toBe("finished");
    expect(state.deadlineAt).toBeNull();
  });

  it("places finishers by elimination order, not seat order", () => {
    // Seats: anna, bo, cara, dan. Anna and Bo bluff and are caught; Dan doubts
    // Cara's honest low claim and loses. Cara wins from seat 2 — the exact seat
    // whose win used to record places 2, 3 and 5 with a skipped 4.
    let state = createGameState("t1", "Test table", seats("anna", "bo", "cara", "dan"), T0);
    beginRoundPlay(state, TIMINGS, T0);

    playerById(state, "anna")!.lives = 1;
    state = rollAs(state, "anna", [3, 1]);
    state = announce(state, "anna", 65);
    state = must(applyAction(state, { type: "doubt", playerId: "bo" }, TIMINGS, T0));
    expect(playerById(state, "anna")!.eliminationIndex).toBe(1);
    expect(state.gameOver).toBeNull();

    state = resolveReveal(state, TIMINGS, T0 + TIMINGS.revealMs);
    beginRoundPlay(state, TIMINGS, T0 + TIMINGS.revealMs);
    playerById(state, "bo")!.lives = 1;
    state = rollAs(state, "bo", [3, 1]);
    state = announce(state, "bo", 65);
    state = must(applyAction(state, { type: "doubt", playerId: "cara" }, TIMINGS, T0));
    expect(playerById(state, "bo")!.eliminationIndex).toBe(2);
    expect(state.gameOver).toBeNull();

    state = resolveReveal(state, TIMINGS, T0 + TIMINGS.revealMs);
    beginRoundPlay(state, TIMINGS, T0 + TIMINGS.revealMs);
    playerById(state, "dan")!.lives = 1;
    state = rollAs(state, "cara", [6, 6]);
    state = announce(state, "cara", 31); // honest: 66 outranks 31
    state = must(applyAction(state, { type: "doubt", playerId: "dan" }, TIMINGS, T0));
    expect(playerById(state, "dan")!.eliminationIndex).toBe(3);
    expect(state.gameOver?.winnerId).toBe("cara");

    expect(finalStandings(state).map(({ player, place }) => [player.id, place])).toEqual([
      ["cara", 1],
      ["dan", 2],
      ["bo", 3],
      ["anna", 4],
    ]);
  });

  it("breaks a simultaneous elimination tie on roster order", () => {
    // One life-loss event can only knock out one player in normal play, so a
    // simultaneous elimination is constructed directly. The documented rule:
    // the earlier seat is treated as eliminated first and so finishes lower.
    let state = playing("anna", "bo", "cara", "dan");
    playerById(state, "cara")!.lives = 0;
    playerById(state, "dan")!.lives = 0;

    state = rollAs(state, "anna", [3, 1]);
    state = announce(state, "anna", 65);
    state = must(applyAction(state, { type: "doubt", playerId: "bo" }, TIMINGS, T0));

    expect(playerById(state, "cara")!.eliminated).toBe(true);
    expect(playerById(state, "dan")!.eliminated).toBe(true);
    expect(playerById(state, "cara")!.eliminationIndex).toBe(1);
    expect(playerById(state, "dan")!.eliminationIndex).toBe(2);
  });

  it("refuses further actions once the game is over", () => {
    let state = playing("anna", "bo");
    playerById(state, "bo")!.lives = 1;
    state = rollAs(state, "anna", [6, 6]);
    state = announce(state, "anna", 52);
    state = must(applyAction(state, { type: "believe", playerId: "bo" }, TIMINGS, T0));
    playerById(state, "bo")!.dice = [3, 1];
    state = announce(state, "bo", 63);
    state = must(applyAction(state, { type: "doubt", playerId: "anna" }, TIMINGS, T0));
    expect(fails(applyAction(state, { type: "roll", playerId: "anna" }, TIMINGS, T0))).toBe("finished");
  });

  it("never mutates the state handed to applyAction", () => {
    const state = playing("anna", "bo");
    const snapshot = structuredClone(state);
    must(applyAction(state, { type: "roll", playerId: "anna" }, TIMINGS, T0));
    expect(state).toEqual(snapshot);
  });
});

describe("auto-play", () => {
  it("rolls and announces the minimum when opening a round", () => {
    const state = playing("anna", "bo");
    const queue = autoPlaySequence(state, "anna");
    expect(queue.map((action) => action.type)).toEqual(["roll", "announce"]);
    expect(queue[1]).toEqual({ type: "announce", playerId: "anna", value: 31 });
  });

  it("believes and announces the minimum above the standing claim", () => {
    let state = playing("anna", "bo");
    state = rollAs(state, "anna", [6, 3]);
    state = announce(state, "anna", 53);
    const queue = autoPlaySequence(state, "bo");
    expect(queue.map((action) => action.type)).toEqual(["believe", "announce"]);
    expect(queue[1]).toEqual({ type: "announce", playerId: "bo", value: 54 });
  });

  it("doubts when Mia stands", () => {
    let state = playing("anna", "bo");
    state = rollAs(state, "anna", [2, 1]);
    state = announce(state, "anna", MIA);
    expect(autoPlaySequence(state, "bo")).toEqual([{ type: "doubt", playerId: "bo" }]);
  });

  it("announces the minimum when holding the cup after a roll", () => {
    let state = playing("anna", "bo");
    state = rollAs(state, "anna", [1, 1]);
    const queue = autoPlaySequence(state, "anna");
    expect(queue).toEqual([{ type: "announce", playerId: "anna", value: 31 }]);
  });

  it("survives a full game driven only by auto-play", () => {
    let state = createGameState("t1", "Auto table", seats("anna", "bo", "cara", "dan"), T0);
    beginRoundPlay(state, TIMINGS, T0);
    let clock = T0;
    let rounds = 0;
    for (let step = 0; step < 2_000 && !state.gameOver; step++) {
      if (state.phase === "roundStart") {
        const next = structuredClone(state);
        beginRoundPlay(next, TIMINGS, clock);
        state = next;
        continue;
      }
      if (state.phase === "revealing") {
        state = resolveReveal(state, TIMINGS, clock);
        rounds = state.round;
        continue;
      }
      const playerId = state.turnPlayerId!;
      const queue = autoPlaySequence(state, playerId);
      expect(queue.length).toBeGreaterThan(0);
      for (const action of queue) {
        const result = applyAction(state, action, TIMINGS, clock);
        expect(result.ok, `auto-play ${action.type} was rejected`).toBe(true);
        if (!result.ok) break;
        state = result.state;
        clock += 1_000;
      }
    }
    expect(state.gameOver).not.toBeNull();
    expect(rounds).toBeGreaterThan(1);
    // The survivor is the only player still alive.
    const alive = state.players.filter((player) => !player.eliminated);
    expect(alive).toHaveLength(1);
    expect(alive[0]!.id).toBe(state.gameOver!.winnerId);
  });
});

describe("redaction", () => {
  it("hides every other player's dice until the reveal", () => {
    let state = playing("anna", "bo", "cara");
    state = rollAs(state, "anna", [6, 6]);
    expect(state.diceOwnerId).toBe("anna");

    const forAnna = buildView(state, "anna");
    expect(playerById(forAnna, "anna")!.dice).toEqual([6, 6]);
    const forBo = buildView(state, "bo");
    expect(playerById(forBo, "bo")!.dice).toBeNull();
    expect(playerById(forBo, "cara")!.dice).toBeNull();
    // The cup itself is public: everyone knows who is holding the dice.
    expect(forBo.diceOwnerId).toBe("anna");
  });

  it("does not hand the cup holder anybody else's dice", () => {
    // The regression this pins: redaction used to ask only *whether* a viewer
    // could see dice, not *whose*, so holding the cup revealed everyone else's
    // roll — and with it, whether they had bluffed. Stray dice are planted
    // directly rather than played into place, so this keeps testing the
    // redaction boundary itself even though `takeCup` now clears them at the
    // source. Defence in depth: either fix alone must stop the leak.
    let state = playing("anna", "bo", "cara");
    state = rollAs(state, "anna", [5, 2]);
    playerById(state, "bo")!.dice = [6, 6];
    playerById(state, "cara")!.dice = [4, 1];

    const forAnna = buildView(state, "anna");
    expect(state.diceOwnerId).toBe("anna");
    expect(playerById(forAnna, "anna")!.dice).toEqual([5, 2]);
    expect(playerById(forAnna, "bo")!.dice).toBeNull();
    expect(playerById(forAnna, "cara")!.dice).toBeNull();
  });

  it("keeps one cup: taking it clears the previous holder's dice", () => {
    let state = playing("anna", "bo", "cara");
    state = rollAs(state, "anna", [6, 6]);
    state = announce(state, "anna", 31);
    state = must(applyAction(state, { type: "believe", playerId: "bo" }, TIMINGS, T0));
    expect(state.diceOwnerId).toBe("bo");
    expect(playerById(state, "anna")!.dice).toBeNull();
    expect(playerById(state, "bo")!.dice).not.toBeNull();
  });

  it("turns over only the doubted player's dice, not earlier rolls in the round", () => {
    let state = playing("anna", "bo", "cara");
    state = rollAs(state, "anna", [6, 6]);
    state = announce(state, "anna", 31);
    state = must(applyAction(state, { type: "believe", playerId: "bo" }, TIMINGS, T0));
    playerById(state, "bo")!.dice = [5, 2];
    state = announce(state, "bo", 52);
    state = must(applyAction(state, { type: "doubt", playerId: "cara" }, TIMINGS, T0));

    const view = buildView(state, "cara");
    expect(playerById(view, "bo")!.dice).toEqual([5, 2]);
    // Anna's 6·6 belongs to a bluff that already concluded; it stays in the cup.
    expect(playerById(view, "anna")!.dice).toBeNull();
  });

  it("publishes the actual dice to everyone once a doubt is called", () => {
    let state = playing("anna", "bo");
    state = rollAs(state, "anna", [6, 3]);
    state = announce(state, "anna", 65);
    state = must(applyAction(state, { type: "doubt", playerId: "bo" }, TIMINGS, T0));
    expect(state.phase).toBe("revealing");
    for (const viewer of ["anna", "bo"]) {
      const view = buildView(state, viewer);
      expect(playerById(view, "anna")!.dice).toEqual([6, 3]);
    }
  });

  it("hides the winner from the snapshot until the game is over", () => {
    let state = playing("anna", "bo");
    playerById(state, "bo")!.lives = 1;
    state = rollAs(state, "anna", [6, 6]);
    state = announce(state, "anna", 52);
    state = must(applyAction(state, { type: "believe", playerId: "bo" }, TIMINGS, T0));
    playerById(state, "bo")!.dice = [3, 1];
    state = announce(state, "bo", 63);
    state = must(applyAction(state, { type: "doubt", playerId: "anna" }, TIMINGS, T0));
    expect(state.gameOver).not.toBeNull();
    expect(buildView(state, "anna").gameOver?.winnerId).toBe("anna");
  });
});
