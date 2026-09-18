/**
 * The endgame replay: the engine's per-player tallies, the redaction that holds
 * them back until the game is over, the last round's filmstrip and the stat
 * lines. Plain Node — nothing here touches the Workers runtime.
 */
import { describe, expect, it } from "vitest";
import {
  applyAction,
  beginRoundPlay,
  buildView,
  createGameState,
  emptyPlayerRecord,
  normalizeState,
  playerById,
  resolveReveal,
  type Die,
  type MiaAction,
  type MiaState,
  type PlayerRecord,
} from "../src/shared/mia";
import {
  bluffsOf,
  HONEST_BADGE_LABEL,
  honestWinner,
  lastRoundFilmstrip,
  neverBluffed,
  playerChips,
  playerOutcome,
  statLines,
  thirdPerson,
  YOU,
} from "../src/shared/replay";

const TIMINGS = { turnMs: 60_000, revealMs: 5_000, roundStartMs: 2_000 };
const T0 = 1_700_000_000_000;

function newGame(...names: string[]): MiaState {
  const state = createGameState(
    "t1",
    "Test table",
    names.map((name) => ({ id: name.toLowerCase(), name })),
    T0,
    TIMINGS,
  );
  beginRoundPlay(state, TIMINGS, T0);
  return state;
}

function act(state: MiaState, action: MiaAction): MiaState {
  const result = applyAction(state, action, TIMINGS, T0);
  if (!result.ok) throw new Error(`${action.type} rejected: ${result.error.code} ${result.error.message}`);
  return result.state;
}

/** Roll for `playerId` and plant the dice the engine would have rolled. */
function roll(state: MiaState, playerId: string, dice: [Die, Die]): MiaState {
  const next = act(state, { type: "roll", playerId });
  playerById(next, playerId)!.dice = dice;
  return next;
}

function setLives(state: MiaState, playerId: string, lives: number): void {
  playerById(state, playerId)!.lives = lives;
}

/**
 * One complete round: `starterId` rolls `dice`, announces `value`, and the
 * player whose turn it is next calls the doubt.
 */
function playRound(state: MiaState, starterId: string, dice: [Die, Die], value: number): MiaState {
  const announced = act(roll(state, starterId, dice), { type: "announce", playerId: starterId, value });
  const doubterId = announced.turnPlayerId!;
  return act(announced, { type: "doubt", playerId: doubterId });
}

/** Close the reveal beat, exactly as the alarm does. */
function nextRound(state: MiaState): MiaState {
  return resolveReveal(state, TIMINGS, T0);
}

/** The round-start beat, run inline so a state can be driven straight on. */
function beginRound(state: MiaState): MiaState {
  beginRoundPlay(state, TIMINGS, T0);
  return state;
}

function record(state: MiaState, playerId: string): PlayerRecord {
  const record = playerById(state, playerId)!.record;
  if (record === null) throw new Error(`${playerId} has no record`);
  return record;
}

describe("the per-player tallies", () => {
  it("counts a caught bluff against the announcer and a right doubt for the doubter", () => {
    const state = playRound(newGame("Ann", "Bob"), "ann", [3, 1], 65);

    expect(record(state, "ann")).toEqual({ ...emptyPlayerRecord(), announcements: 1, caught: 1 });
    expect(record(state, "bob")).toEqual({ ...emptyPlayerRecord(), doubts: 1, doubtsCorrect: 1 });
  });

  it("counts a truthful claim the doubter got wrong", () => {
    const state = playRound(newGame("Ann", "Bob"), "ann", [6, 5], 65);

    expect(record(state, "ann")).toEqual({ ...emptyPlayerRecord(), announcements: 1, truths: 1, truthsDoubted: 1 });
    expect(record(state, "bob")).toEqual({ ...emptyPlayerRecord(), doubts: 1 });
  });

  it("counts a claim on the wrong dice as a bluff even when the claim is lower", () => {
    // A claim below the real roll is legal and is still not the roll in the cup.
    const state = playRound(newGame("Ann", "Bob"), "ann", [6, 5], 31);

    expect(record(state, "ann")).toEqual({ ...emptyPlayerRecord(), announcements: 1 });
  });

  it("tallies a whole game across rounds, including the undoubted claims", () => {
    // Ann tells the truth in rounds 1 and 3, and Bob never believes her.
    let state = playRound(newGame("Ann", "Bob"), "ann", [6, 5], 65);
    state = beginRound(nextRound(state));
    state = playRound(state, "bob", [6, 5], 65);
    state = beginRound(nextRound(state));
    state = playRound(state, "ann", [6, 5], 65);

    expect(record(state, "ann")).toEqual({
      ...emptyPlayerRecord(),
      announcements: 2,
      truths: 2,
      truthsDoubted: 2,
      doubts: 1,
    });
    expect(record(state, "bob")).toEqual({
      ...emptyPlayerRecord(),
      announcements: 1,
      truths: 1,
      truthsDoubted: 1,
      doubts: 2,
    });
  });

  it("hides the tallies from every snapshot until the game is over", () => {
    const midGame = playRound(newGame("Ann", "Bob"), "ann", [6, 5], 65);
    for (const viewer of ["ann", "bob", "stranger"]) {
      expect(buildView(midGame, viewer).players.map((player) => player.record)).toEqual([null, null]);
    }

    setLives(midGame, "bob", 1);
    const over = nextRound(midGame);
    const finished = playRound(beginRound(over), "bob", [3, 1], 65);
    expect(finished.gameOver).not.toBeNull();
    const view = buildView(finished, "ann");
    expect(view.players.map((player) => player.record?.announcements)).toEqual([1, 1]);
  });

  it("backfills a state persisted before the record and the rematch pointer existed", () => {
    const finished = playRound(newGame("Ann", "Bob"), "ann", [3, 1], 65);
    const legacy = structuredClone(finished) as unknown as {
      rematchId?: string | null;
      players: { record?: PlayerRecord | null }[];
    };
    delete legacy.rematchId;
    for (const player of legacy.players) delete player.record;

    const restored = normalizeState(legacy as unknown as MiaState);
    expect(restored.rematchId).toBeNull();
    expect(restored.players.map((player) => player.record)).toEqual([emptyPlayerRecord(), emptyPlayerRecord()]);
  });
});

describe("the last-round filmstrip", () => {
  it("replays only the final round's claims, then the doubt and the truth", () => {
    // Two rounds of bluffing, both caught; the last round is the one that ends it.
    let state = newGame("Ann", "Bob", "Cid");
    setLives(state, "ann", 1);
    setLives(state, "bob", 1);
    state = playRound(state, "ann", [3, 1], 65);
    state = beginRound(nextRound(state));
    expect(state.round).toBe(2);
    const finished = playRound(state, "bob", [3, 1], 65);
    expect(finished.gameOver?.winnerId).toBe("cid");

    const strip = lastRoundFilmstrip(finished);
    expect(strip.round).toBe(2);
    expect(strip.frames.map((frame) => frame.kind)).toEqual(["claim", "doubt", "truth"]);
    expect(strip.frames[0]).toMatchObject({ playerId: "bob", playerName: "Bob", value: 65 });
    expect(strip.frames[1]).toMatchObject({ kind: "doubt", playerId: "cid", playerName: "Cid" });
    expect(strip.frames[2]).toMatchObject({
      playerId: "bob",
      value: 31,
      announced: 65,
      bluff: true,
      livesLost: 1,
      penaltyApplied: "single",
    });
    expect(strip.caption).toContain("Bob claimed 6·5 on a 3·1.");
    expect(strip.caption).toContain("Bob lost their last life and the game.");
  });

  it("ends the strip on the claim the reveal actually turned over", () => {
    const finished = playRound(newGame("Ann", "Bob"), "ann", [4, 2], 31);

    const strip = lastRoundFilmstrip(finished);
    const claims = strip.frames.filter((frame) => frame.kind === "claim");
    expect(claims).toHaveLength(1);
    expect(claims[claims.length - 1]!.value).toBe(finished.lastReveal?.announced);
    expect(finished.lastReveal?.announced).toBe(31);
  });

  it("names a real Mia and the double charge to the doubter", () => {
    const state = newGame("Ann", "Bob");
    setLives(state, "bob", 2);
    const finished = playRound(state, "ann", [2, 1], 21);

    const truth = lastRoundFilmstrip(finished).frames.at(-1)!;
    expect(truth).toMatchObject({ value: 21, bluff: false, livesLost: 2, penaltyApplied: "double-mia" });
    const caption = lastRoundFilmstrip(finished).caption;
    expect(caption).toContain("Bob doubted Ann — and the MIA was real.");
    expect(caption).toContain("Bob lost two and the game.");
  });

  it("is a single claim for a game that ends in round one", () => {
    const state = newGame("Ann", "Bob");
    setLives(state, "ann", 1);
    const finished = playRound(state, "ann", [3, 1], 65);

    const strip = lastRoundFilmstrip(finished);
    expect(strip.round).toBe(1);
    expect(strip.frames).toHaveLength(3);
  });
});

describe("the stat lines", () => {
  const record = (patch: Partial<PlayerRecord>): PlayerRecord => ({ ...emptyPlayerRecord(), ...patch });

  it("says the line the screenshot is for", () => {
    const twoTruths = record({ announcements: 2, truths: 2, truthsDoubted: 2 });
    expect(statLines(twoTruths, YOU)).toEqual([
      "You told the truth twice all game. Both times, nobody believed you.",
    ]);
    expect(statLines(twoTruths, thirdPerson("Damp Ferret"))).toEqual([
      "Damp Ferret told the truth twice all game. Both times, nobody believed them.",
    ]);
  });

  it("gives a player who never announced the cup line, not a zero", () => {
    expect(statLines(record({ doubts: 3 }), YOU)).toEqual([
      "You never picked up the cup.",
      "You called 3 doubts and got every one wrong.",
    ]);
    expect(statLines(record({ doubts: 1, doubtsCorrect: 1 }), thirdPerson("Cid"))).toEqual([
      "Cid never picked up the cup.",
      "Cid called 1 doubt and got it right every time.",
    ]);
  });

  it("separates the caught bluffs from the ones nobody called", () => {
    expect(statLines(record({ announcements: 4, caught: 1 }), YOU)).toEqual([
      "You never named your real roll, and got caught once.",
    ]);
    expect(statLines(record({ announcements: 4 }), YOU)).toEqual([
      "You never named your real roll, and nobody ever caught on.",
    ]);
  });

  it("counts the truths somebody still doubted", () => {
    expect(statLines(record({ announcements: 3, truths: 3 }), YOU)).toEqual([
      "You told the truth 3 times all game.",
    ]);
    expect(statLines(record({ announcements: 3, truths: 2, truthsDoubted: 1 }), YOU)).toEqual([
      "You told the truth twice all game. Somebody still doubted you once.",
    ]);
    expect(statLines(record({ announcements: 4, truths: 3, truthsDoubted: 3 }), YOU)).toEqual([
      "You told the truth 3 times all game. Nobody believed you any of those times.",
    ]);
  });

  it("never prints a zero, a NaN or an empty line for any reachable record", () => {
    for (const announcements of [0, 1, 2, 5]) {
      for (const truths of [0, 1, announcements]) {
        if (truths > announcements) continue;
        for (const truthsDoubted of [0, 1, truths]) {
          for (const doubts of [0, 1, 4]) {
            for (const doubtsCorrect of [0, 1, doubts]) {
              for (const caught of [0, 1, announcements - truths]) {
                if (caught > announcements - truths) continue;
                const lines = statLines(
                  { announcements, truths, truthsDoubted, doubts, doubtsCorrect, caught },
                  YOU,
                );
                expect(lines.length).toBeGreaterThan(0);
                for (const line of lines) {
                  expect(line).not.toMatch(/NaN|undefined|\b0 times\b|  /);
                  expect(line.endsWith(".")).toBe(true);
                }
              }
            }
          }
        }
      }
    }
  });
});

describe("the endgame numbers", () => {
  it("reports the liar rate only when there is a claim to be a rate of", () => {
    expect(playerChips({ ...emptyPlayerRecord(), announcements: 3, truths: 1, caught: 1 })).toEqual([
      { label: "Claims", value: "3" },
      { label: "Bluffs", value: "2" },
      { label: "Caught", value: "1" },
      { label: "Liar rate", value: "67%" },
    ]);
    expect(playerChips({ ...emptyPlayerRecord(), doubts: 2, doubtsCorrect: 1 })).toEqual([
      { label: "Doubts", value: "2" },
      { label: "Right", value: "1" },
    ]);
    expect(playerChips(emptyPlayerRecord())).toEqual([]);
  });

  it("says how each player finished", () => {
    const state = newGame("Ann", "Bob");
    setLives(state, "bob", 1);
    const finished = playRound(state, "ann", [6, 5], 65);

    const winner = playerById(finished, "ann")!;
    const loser = playerById(finished, "bob")!;
    expect(playerOutcome(winner)).toBe("6 lives left");
    expect(playerOutcome(loser)).toBe("out in round 1");
  });
});

describe("the honest-player badge", () => {
  /** Ann names 65 on a 65; Bob doubts, is on one life, and is out. */
  function honestWin(): MiaState {
    const state = newGame("Ann", "Bob");
    setLives(state, "bob", 1);
    return playRound(state, "ann", [6, 5], 65);
  }

  it("names a winner who announced and never bluffed", () => {
    const finished = honestWin();
    expect(finished.gameOver?.winnerId).toBe("ann");
    expect(record(finished, "ann")).toMatchObject({ announcements: 1, truths: 1 });
    expect(honestWinner(finished)?.id).toBe("ann");
    expect(HONEST_BADGE_LABEL).toBe("Never once bluffed");
  });

  it("does not name a winner who bluffed even once", () => {
    const finished = honestWin();
    playerById(finished, "ann")!.record = { ...emptyPlayerRecord(), announcements: 3, truths: 2 };
    expect(honestWinner(finished)).toBeNull();
  });

  it("does not name a winner who never announced", () => {
    const finished = honestWin();
    playerById(finished, "ann")!.record = { ...emptyPlayerRecord(), doubts: 4, doubtsCorrect: 4 };
    expect(neverBluffed(record(finished, "ann"))).toBe(false);
    expect(honestWinner(finished)).toBeNull();
  });

  it("does not name a loser who never bluffed", () => {
    const finished = honestWin();
    playerById(finished, "bob")!.record = { ...emptyPlayerRecord(), announcements: 2, truths: 2 };
    expect(neverBluffed(record(finished, "bob"))).toBe(true);
    expect(honestWinner(finished)?.id).toBe("ann");

    playerById(finished, "ann")!.record = { ...emptyPlayerRecord(), announcements: 1 };
    expect(honestWinner(finished)).toBeNull();
  });

  it("looks at the whole game, not only the last round", () => {
    const finished = honestWin();
    // Last claim was true; three earlier ones were not. A lastReveal-only
    // check would still name Ann, because the finishing doubt was on a truth.
    playerById(finished, "ann")!.record = { ...emptyPlayerRecord(), announcements: 4, truths: 1 };
    expect(finished.lastReveal?.verdict).toBe("doubter");
    expect(honestWinner(finished)).toBeNull();
  });

  it("counts an earlier bluff against a later honest finishing claim", () => {
    // Round 1: Ann bluffs, Bob catches her. She loses a life and starts again.
    let state = playRound(newGame("Ann", "Bob"), "ann", [3, 1], 65);
    expect(record(state, "ann")).toMatchObject({ announcements: 1, truths: 0 });
    state = beginRound(nextRound(state));
    setLives(state, "bob", 1);
    const finished = playRound(state, "ann", [6, 5], 65);
    expect(finished.gameOver?.winnerId).toBe("ann");
    expect(record(finished, "ann")).toMatchObject({ announcements: 2, truths: 1 });
    expect(honestWinner(finished)).toBeNull();
  });

  it("does not name a winner who never picked up the cup", () => {
    // Cid only ever doubts. Ann and Bob knock each other out.
    let state = newGame("Ann", "Bob", "Cid");
    setLives(state, "ann", 1);
    setLives(state, "bob", 1);
    state = playRound(state, "ann", [3, 1], 65);
    state = beginRound(nextRound(state));
    const finished = playRound(state, "bob", [3, 1], 65);
    expect(finished.gameOver?.winnerId).toBe("cid");
    expect(record(finished, "cid").announcements).toBe(0);
    expect(honestWinner(finished)).toBeNull();
  });

  it("is silent before the game is over, including on a redacted mid-game view", () => {
    const midGame = playRound(newGame("Ann", "Bob"), "ann", [6, 5], 65);
    expect(midGame.gameOver).toBeNull();
    expect(honestWinner(midGame)).toBeNull();
    expect(honestWinner(buildView(midGame, "ann"))).toBeNull();
    expect(buildView(midGame, "ann").players.every((player) => player.record === null)).toBe(true);
  });

  it("still names the honest winner from a finished snapshot", () => {
    const view = buildView(honestWin(), "bob");
    expect(view.players.map((player) => player.record !== null)).toEqual([true, true]);
    expect(honestWinner(view)?.id).toBe("ann");
  });

  it("treats a claim below the real roll as a bluff, matching the chips", () => {
    // Same definition as `playerChips`: the claim is not the dice they hold.
    const understated = { ...emptyPlayerRecord(), announcements: 2, truths: 1 };
    expect(bluffsOf(understated)).toBe(1);
    expect(neverBluffed(understated)).toBe(false);
    expect(neverBluffed({ ...emptyPlayerRecord(), announcements: 2, truths: 2 })).toBe(true);
    expect(neverBluffed(emptyPlayerRecord())).toBe(false);
  });
});
