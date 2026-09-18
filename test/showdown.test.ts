/**
 * The showdown's staging is a pure, DOM-free transform of the reveal and the
 * server clock, so it can be pinned under plain Node the way the seat geometry
 * and the countdown are. `client/src/table.ts` cannot be imported here (it
 * queries `#app` at module scope), which is exactly why the verdict mapping and
 * the beat arithmetic live in `src/shared/showdown.ts`.
 *
 * The three properties worth guarding:
 *
 * - the stamp names the engine's verdict, including the one double charge that
 *   lands on the *doubter* (a real `21`), never the announcer;
 * - a caught bluff and an honest claim are distinguishable — opposite emotions
 *   must not share a layout;
 * - the beats are a fraction of the *server's* reveal window, so a shortened
 *   clock compresses the staging instead of desyncing from the alarm;
 * - thunder is the typed `double-mia` penalty, and two pips go out one after
 *   the other, including when that charge eliminates.
 */
import { describe, expect, it } from "vitest";
import { MIA, type DoubtReveal } from "../src/shared/mia";
import {
  CUP_BEAT_ENDS,
  DICE_BEAT_ENDS,
  showdownLoser,
  showdownLoss,
  showdownSentence,
  showdownStamp,
  showdownThunder,
  showdownTiming,
  showdownTone,
  showdownValue,
} from "../src/shared/showdown";

/** A bluff that got caught: claimed Mia while holding 5·3. */
const CAUGHT_BLUFF: DoubtReveal = {
  doubterId: "doubter",
  doubterName: "Damp Ferret",
  announcerId: "announcer",
  announcerName: "Likely Kestrel",
  announced: MIA,
  actual: 53,
  verdict: "announcer",
  livesLost: 1,
  penaltyApplied: "single",
};

/** An honest claim the doubter was wrong about: claimed and rolled 5·3. */
const HONEST_CLAIM: DoubtReveal = {
  ...CAUGHT_BLUFF,
  announced: 53,
  actual: 53,
  verdict: "doubter",
};

/** A real Mia: doubting it costs the doubter two lives. */
const REAL_MIA: DoubtReveal = {
  ...CAUGHT_BLUFF,
  announced: MIA,
  actual: MIA,
  verdict: "doubter",
  livesLost: 2,
  penaltyApplied: "double-mia",
};

describe("showdownStamp", () => {
  it("names the engine's verdict", () => {
    expect(showdownStamp(CAUGHT_BLUFF)).toBe("BLUFF");
    expect(showdownStamp(HONEST_CLAIM)).toBe("TRUE");
    expect(showdownStamp(REAL_MIA)).toBe("MIA");
  });

  it("keeps a caught bluff and an honest claim distinguishable", () => {
    expect(showdownStamp(CAUGHT_BLUFF)).not.toBe(showdownStamp(HONEST_CLAIM));
    expect(showdownTone(CAUGHT_BLUFF)).not.toBe(showdownTone(HONEST_CLAIM));
    expect(showdownTone(CAUGHT_BLUFF)).toBe("caught");
    expect(showdownTone(HONEST_CLAIM)).toBe("believed");
  });

  it("charges the doubter for a real Mia, never the announcer", () => {
    expect(showdownTone(REAL_MIA)).toBe("mia");
    expect(showdownLoser(REAL_MIA)).toEqual({ id: "doubter", name: "Damp Ferret", livesLost: 2 });
    // The other two verdicts charge the right player too.
    expect(showdownLoser(CAUGHT_BLUFF).id).toBe("announcer");
    expect(showdownLoser(HONEST_CLAIM).id).toBe("doubter");
  });
});

describe("showdownTiming", () => {
  const START = 1_700_000_000_000;

  it("walks the three beats across the server's window", () => {
    const deadline = START + 5_000;
    expect(showdownTiming(START, deadline, START)).toMatchObject({ span: 5_000, elapsed: 0, beat: 1, done: false });
    expect(showdownTiming(START, deadline, START + 1_000).beat).toBe(1); // 20% — cup still up
    expect(showdownTiming(START, deadline, START + 1_500).beat).toBe(2); // 30% — dice tumble
    expect(showdownTiming(START, deadline, START + 4_000).beat).toBe(3); // 80% — stamp landed
    expect(showdownTiming(START, deadline, START + 5_000)).toMatchObject({ elapsed: 5_000, beat: 3, done: true });
    expect(showdownTiming(START, deadline, START + 9_000)).toMatchObject({ elapsed: 5_000, beat: 3, done: true });
  });

  it("stages a fraction of whatever window the clock gives it", () => {
    // The fast-clock case: workers tests shorten `revealMs` to milliseconds.
    // A staging that hardcoded 4000ms would read 100/4000 as 2.5% and stay in
    // beat 1; a window-relative one is already halfway through beat 2.
    const fastStart = 1_700_000_000_000;
    expect(showdownTiming(fastStart, fastStart + 200, fastStart + 100).beat).toBe(2);
    expect(showdownTiming(fastStart, fastStart + 200, fastStart + 10).beat).toBe(1);
    expect(showdownTiming(fastStart, fastStart + 200, fastStart + 160).beat).toBe(3);
    expect(showdownTiming(fastStart, fastStart + 200, fastStart + 200).done).toBe(true);

    // Halfway through the window is the same beat whatever the window is.
    for (const span of [200, 1_000, 5_000, 60_000]) {
      expect(showdownTiming(START, START + span, START + span / 2).beat, `span ${span}`).toBe(2);
    }
  });

  it("settles at beat 3 when there is no reveal window", () => {
    // The null window is a defensive path, not the game-ending doubt: that
    // doubt becomes `finished` inside `resolveDoubt` (its trailing
    // `resolveEliminations` clears `deadlineAt`), so `showdownTiming` is never
    // asked to animate it. The function still has to be total with no window.
    expect(showdownTiming(null, null, START)).toEqual({ span: 0, elapsed: 0, beat: 3, done: true });
    expect(showdownTiming(START, null, START)).toEqual({ span: 0, elapsed: 0, beat: 3, done: true });
  });

  it("keeps the cup and dice boundaries ordered", () => {
    // Pinned so a "cleanup" cannot put the dice before the cup or the stamp
    // before the dice.
    expect(CUP_BEAT_ENDS).toBeGreaterThan(0);
    expect(DICE_BEAT_ENDS).toBeGreaterThan(CUP_BEAT_ENDS);
    expect(DICE_BEAT_ENDS).toBeLessThan(1);
  });
});

describe("showdownThunder / showdownLoss", () => {
  it("keys thunder off the typed penalty, not off livesLost === 2", () => {
    expect(showdownThunder(REAL_MIA)).toBe(true);
    expect(showdownThunder(CAUGHT_BLUFF)).toBe(false);
    expect(showdownThunder(HONEST_CLAIM)).toBe(false);

    // A forged reveal that charges two under a single penalty is not thunder.
    // This is the assertion that fails if the view ever writes `livesLost === 2`.
    const forgedDouble: DoubtReveal = { ...CAUGHT_BLUFF, livesLost: 2, penaltyApplied: "single" };
    expect(showdownThunder(forgedDouble)).toBe(false);
    expect(showdownLoss(forgedDouble, 4).thunder).toBe(false);
    expect(showdownLoss(forgedDouble, 4).vanished).toBe(2);
  });

  it("puts two pips out in sequence when the doubled charge leaves lives behind", () => {
    const loss = showdownLoss(REAL_MIA, 4);
    expect(loss).toMatchObject({ thunder: true, vanished: 2, remaining: 4, eliminated: false });
    expect(loss.pips.map((pip) => pip.kind)).toEqual(["on", "on", "on", "on", "lost", "lost"]);
    expect(loss.pips[4]).toMatchObject({ kind: "lost", strike: 1, thunder: false });
    expect(loss.pips[5]).toMatchObject({ kind: "lost", strike: 2, thunder: true });
  });

  it("extinguishes two pips and reads as out when the doubled charge takes the last two", () => {
    const reveal: DoubtReveal = { ...REAL_MIA, livesBefore: 2 };
    const loss = showdownLoss(reveal, 0);
    expect(loss).toMatchObject({ thunder: true, vanished: 2, remaining: 0, eliminated: true });
    expect(loss.pips.filter((pip) => pip.kind === "lost")).toHaveLength(2);
    expect(loss.pips[0]).toMatchObject({ strike: 1, thunder: false });
    expect(loss.pips[1]).toMatchObject({ strike: 2, thunder: true });
  });

  it("does not invent a second pip when the doubled penalty eliminates on one life", () => {
    const reveal: DoubtReveal = { ...REAL_MIA, livesBefore: 1 };
    const loss = showdownLoss(reveal, 0);
    expect(loss).toMatchObject({ thunder: true, vanished: 1, remaining: 0, eliminated: true });
    // The one remaining pip is the heavier hit, so −2 can land before it goes.
    expect(loss.pips[0]).toMatchObject({ kind: "lost", strike: 2, thunder: true });
    expect(loss.pips.slice(1).every((pip) => pip.kind === "off")).toBe(true);
  });

  it("snuffs one pip, without thunder, for a single-life loss", () => {
    const loss = showdownLoss(CAUGHT_BLUFF, 5);
    expect(loss).toMatchObject({ thunder: false, vanished: 1, remaining: 5, eliminated: false });
    expect(loss.pips.map((pip) => pip.kind)).toEqual(["on", "on", "on", "on", "on", "lost"]);
    expect(loss.pips[5]).toMatchObject({ kind: "lost", strike: 1, thunder: false });
  });

  it("reconstructs livesBefore from remaining + livesLost when the field is missing", () => {
    // A room persisted before livesBefore existed. The common path (they had
    // at least as many lives as the charge) still reconstructs correctly.
    expect(REAL_MIA.livesBefore).toBeUndefined();
    const loss = showdownLoss(REAL_MIA, 4);
    expect(loss.vanished).toBe(2);
    expect(loss.thunder).toBe(true);
  });
});

describe("showdownValue / showdownSentence", () => {
  it("reads a Mia roll as MIA, never 2·1", () => {
    expect(showdownValue(MIA)).toBe("MIA");
    expect(showdownValue(53)).toBe("5·3");
    expect(showdownValue(MIA)).not.toContain("2·1");
  });

  it("names the truth and the claim, and reads MIA in a Mia verdict", () => {
    const caught = showdownSentence(CAUGHT_BLUFF);
    expect(caught).toContain("5·3");
    expect(caught).toContain("MIA");
    expect(caught).toContain("Bluff caught");
    expect(caught).not.toContain("2·1");

    const mia = showdownSentence(REAL_MIA);
    expect(mia).toContain("MIA");
    expect(mia).not.toContain("2·1");
    expect(mia).toContain("Doubled — the Mia was real.");
  });

  it("charges the player the engine charged", () => {
    // A caught bluff: the announcer pays, and the doubter is only the doubter.
    expect(showdownSentence(CAUGHT_BLUFF)).toContain("Bluff caught — loses 1 life.");
    // A believed claim: the doubter pays one.
    expect(showdownSentence(HONEST_CLAIM)).toContain("Damp Ferret doubted — loses 1 life.");
    // A real Mia: the doubter pays two, and the doubling is named.
    expect(showdownSentence(REAL_MIA)).toContain("Damp Ferret doubted — loses 2 lives.");
  });
});
