/**
 * Delight cues fire on the transition, not the state. A reconnect replays the
 * current snapshot, so a check written against "it is your turn" would rattle
 * the cup for a life lost ten minutes ago.
 */
import { describe, expect, it } from "vitest";
import {
  applyAction,
  beginRoundPlay,
  createGameState,
  playerById,
  type Die,
  type MiaState,
} from "../src/shared/mia";
import { CueTracker, cueSnapOf, cuesBetween, type CueSnap } from "../src/shared/table-cues";

const TIMINGS = { turnMs: 60_000, revealMs: 5_000, roundStartMs: 2_000 };
const T0 = 1_700_000_000_000;

function seats(...names: string[]): { id: string; name: string }[] {
  return names.map((name) => ({ id: name.toLowerCase(), name }));
}

function playing(...names: string[]): MiaState {
  const state = createGameState("t1", "Test table", seats(...names), T0);
  beginRoundPlay(state, TIMINGS, T0);
  return state;
}

function must(result: ReturnType<typeof applyAction>): MiaState {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.state;
}

function rollAs(state: MiaState, playerId: string, dice: [Die, Die], at = T0): MiaState {
  const rolled = must(applyAction(state, { type: "roll", playerId }, TIMINGS, at));
  playerById(rolled, playerId)!.dice = dice;
  return rolled;
}

function snap(partial: Partial<CueSnap> & Pick<CueSnap, "you">): CueSnap {
  return {
    turnPlayerId: null,
    pendingDoubtAnnouncerId: null,
    revealKey: null,
    yourLives: 6,
    ...partial,
  };
}

describe("cuesBetween", () => {
  it("fires nothing on the first snapshot, even when it is already your turn", () => {
    const next = snap({ you: "ada", turnPlayerId: "ada", yourLives: 4, revealKey: "a:b:65:31:3" });
    expect(cuesBetween(null, next)).toEqual([]);
  });

  it("treats a change of viewer as a first snapshot", () => {
    const prev = snap({ you: "ada", turnPlayerId: "bea" });
    const next = snap({ you: "bea", turnPlayerId: "bea" });
    expect(cuesBetween(prev, next)).toEqual([]);
  });

  it("rattles the cup only when the turn arrives, not while it stays", () => {
    const idle = snap({ you: "ada", turnPlayerId: "bea" });
    const yours = snap({ you: "ada", turnPlayerId: "ada" });
    expect(cuesBetween(idle, yours)).toEqual(["your-turn"]);
    expect(cuesBetween(yours, yours)).toEqual([]);
  });

  it("does not rattle when the turn leaves you or goes to someone else", () => {
    const yours = snap({ you: "ada", turnPlayerId: "ada" });
    const theirs = snap({ you: "ada", turnPlayerId: "bea" });
    expect(cuesBetween(yours, theirs)).toEqual([]);
    expect(cuesBetween(theirs, snap({ you: "ada", turnPlayerId: "cal" }))).toEqual([]);
  });

  it("fires doubted only for the announcer named by the new pending doubt", () => {
    const before = snap({ you: "ada", turnPlayerId: "bea" });
    const after = snap({
      you: "ada",
      pendingDoubtAnnouncerId: "ada",
      revealKey: "ada:bea:65:31:1",
    });
    expect(cuesBetween(before, after)).toEqual(["doubted", "reveal"]);
    expect(
      cuesBetween(
        snap({ you: "bea", turnPlayerId: "bea" }),
        snap({ you: "bea", pendingDoubtAnnouncerId: "ada", revealKey: "ada:bea:65:31:1" }),
      ),
    ).toEqual(["reveal"]);
  });

  it("fires life-lost only when this viewer's lives drop", () => {
    const six = snap({ you: "ada", yourLives: 6 });
    expect(cuesBetween(six, snap({ you: "ada", yourLives: 5 }))).toEqual(["life-lost"]);
    expect(cuesBetween(six, snap({ you: "ada", yourLives: 6 }))).toEqual([]);
    expect(cuesBetween(six, snap({ you: "ada", yourLives: 7 }))).toEqual([]);
  });

  it("does not fire life-lost for a spectator with no seat", () => {
    const prev = snap({ you: "watcher", yourLives: null });
    const next = snap({ you: "watcher", yourLives: null, revealKey: "ada:bea:65:31:1" });
    expect(cuesBetween(prev, next)).toEqual(["reveal"]);
  });

  it("fires reveal once per new doubt, not again on a later snapshot of the same one", () => {
    const quiet = snap({ you: "cal" });
    const live = snap({ you: "cal", revealKey: "ada:bea:65:31:1" });
    expect(cuesBetween(quiet, live)).toEqual(["reveal"]);
    expect(cuesBetween(live, live)).toEqual([]);
    expect(cuesBetween(live, snap({ you: "cal", revealKey: null }))).toEqual([]);
  });

  it("can emit doubted, life-lost and reveal together when a bluff is caught", () => {
    const before = snap({ you: "ada", turnPlayerId: "bea", yourLives: 6 });
    const after = snap({
      you: "ada",
      turnPlayerId: null,
      pendingDoubtAnnouncerId: "ada",
      revealKey: "ada:bea:65:31:1",
      yourLives: 5,
    });
    expect(cuesBetween(before, after)).toEqual(["doubted", "life-lost", "reveal"]);
  });
});

describe("CueTracker", () => {
  it("baselines the first observe and fires when the turn arrives", () => {
    const tracker = new CueTracker();
    let state = playing("Ada", "Bea");
    expect(tracker.observe(state, "bea")).toEqual([]);
    state = rollAs(state, "ada", [3, 1]);
    state = must(applyAction(state, { type: "announce", playerId: "ada", value: 31 }, TIMINGS, T0));
    expect(state.turnPlayerId).toBe("bea");
    expect(tracker.observe(state, "bea")).toEqual(["your-turn"]);
  });

  it("fires nothing for a reconnect that replays the current snapshot", () => {
    const tracker = new CueTracker();
    let state = playing("Ada", "Bea");
    expect(tracker.observe(state, "bea")).toEqual([]);
    state = rollAs(state, "ada", [3, 1]);
    state = must(applyAction(state, { type: "announce", playerId: "ada", value: 31 }, TIMINGS, T0));
    expect(state.turnPlayerId).toBe("bea");
    // Without reset this is exactly "the cup just reached you". A reconnect
    // mid-game must not treat the replayed snapshot as that transition.
    tracker.reset();
    expect(tracker.observe(state, "bea")).toEqual([]);
  });

  it("reads a real caught bluff the way the table will", () => {
    let state = playing("Ada", "Bea");
    state = rollAs(state, "ada", [3, 1]);
    state = must(applyAction(state, { type: "announce", playerId: "ada", value: 65 }, TIMINGS, T0));
    const adaBefore = cueSnapOf(state, "ada");
    const beaBefore = cueSnapOf(state, "bea");
    const after = must(applyAction(state, { type: "doubt", playerId: "bea" }, TIMINGS, T0));
    expect(cuesBetween(adaBefore, cueSnapOf(after, "ada"))).toEqual(["doubted", "life-lost", "reveal"]);
    expect(cuesBetween(beaBefore, cueSnapOf(after, "bea"))).toEqual(["reveal"]);
  });

  it("reads a real honest claim the doubter got wrong", () => {
    let state = playing("Ada", "Bea");
    state = rollAs(state, "ada", [3, 1]);
    state = must(applyAction(state, { type: "announce", playerId: "ada", value: 31 }, TIMINGS, T0));
    const adaBefore = cueSnapOf(state, "ada");
    const beaBefore = cueSnapOf(state, "bea");
    const after = must(applyAction(state, { type: "doubt", playerId: "bea" }, TIMINGS, T0));
    expect(cuesBetween(adaBefore, cueSnapOf(after, "ada"))).toEqual(["doubted", "reveal"]);
    expect(cuesBetween(beaBefore, cueSnapOf(after, "bea"))).toEqual(["life-lost", "reveal"]);
  });
});
