/**
 * The gap gauge is a pure read of the announce ladder's existing inputs, so it
 * lives in `src/shared/gap-gauge.ts` and is pinned here under plain Node.
 * `client/src/table.ts` cannot be imported (it queries `#app` at module scope).
 *
 * The properties worth guarding:
 *
 * - the cheapest claim is the last entry of the announcements list the ladder
 *   already has, never a re-rank of the standing value;
 * - the rung count is a `RANKING` index distance, never encoded-roll arithmetic
 *   (`63 - 31` is 32, and `11` outranks `65` while `11 > 65` is false);
 * - opening the round is its own kind — there is no standing claim to be
 *   distant from — even though the held roll is in the legal set;
 * - an honest held roll is not drawn as a climb.
 */
import { describe, expect, it } from "vitest";
import { gapCopy, gapGauge, gapValueLabel } from "../src/shared/gap-gauge";
import { legalAnnouncements, MIA, RANKING } from "../src/shared/mia";

describe("gapGauge", () => {
  it("counts RANKING steps from the held roll up to the cheapest legal claim", () => {
    // Standing 62 → cheapest is 63. Held 31 is eleven rungs below 63 in RANKING
    // (21,66,55,44,33,22,11,65,64,63, …, 31): index 20 − index 9.
    const gauge = gapGauge(legalAnnouncements(62), 31, 62);
    expect(gauge.kind).toBe("climb");
    expect(gauge.held).toBe(31);
    expect(gauge.cheapest).toBe(63);
    expect(gauge.rungs).toBe(11);
    expect(gauge.fill).toBeCloseTo(11 / 20);
  });

  it("is one rung when the held roll is the standing claim", () => {
    const gauge = gapGauge(legalAnnouncements(62), 62, 62);
    expect(gauge.kind).toBe("climb");
    expect(gauge.cheapest).toBe(63);
    expect(gauge.rungs).toBe(1);
    expect(gauge.fill).toBeCloseTo(1 / 10);
  });

  it("takes the cheapest from the announcements list, not by re-ranking the standing claim", () => {
    // A prefix of what `legalAnnouncements(65)` would return. Re-deriving
    // from `standing` would put the cheapest at 11, the real last legal.
    const gauge = gapGauge([21, 66, 55], 31, 65);
    expect(gauge.cheapest).toBe(55);
    expect(gauge.rungs).toBe(18);
    expect(legalAnnouncements(65).at(-1)).toBe(11);
  });

  it("does not use encoded-roll arithmetic, so 11 above 65 is still a climb", () => {
    // 11 outranks 65. Numeric `<` / `>` would treat held 31 as already above
    // cheapest 11, or count `11 - 31` as a negative span.
    const announcements = legalAnnouncements(65);
    const gauge = gapGauge(announcements, 31, 65);
    expect(announcements.at(-1)).toBe(11);
    expect(gauge.kind).toBe("climb");
    expect(gauge.cheapest).toBe(11);
    expect(gauge.rungs).toBe(14);
    expect(gauge.fill).toBeCloseTo(14 / 20);
  });

  it("degrades to open when there is no standing claim to be distant from", () => {
    // The held roll is in the legal set (every rung is), but opening is not
    // an honest climb of zero — there is no cut.
    const gauge = gapGauge([...RANKING], 54, null);
    expect(gauge.kind).toBe("open");
    expect(gauge.rungs).toBe(0);
    expect(gauge.fill).toBeNull();
    expect(gauge.held).toBe(54);
    expect(gauge.cheapest).toBe(31);
  });

  it("stays open even when the handed list is not the full ranking", () => {
    const gauge = gapGauge([21, 66], 66, null);
    expect(gauge.kind).toBe("open");
    expect(gauge.rungs).toBe(0);
    expect(gauge.fill).toBeNull();
  });

  it("is honest when the held roll is in the announcements list", () => {
    const announcements = legalAnnouncements(62);
    expect(announcements).toContain(65);
    const gauge = gapGauge(announcements, 65, 62);
    expect(gauge.kind).toBe("honest");
    expect(gauge.rungs).toBe(0);
    expect(gauge.fill).toBeNull();
    expect(gauge.cheapest).toBe(63);
  });

  it("is empty without a held roll or a cheapest claim", () => {
    expect(gapGauge(legalAnnouncements(62), null, 62).kind).toBe("empty");
    expect(gapGauge([], 31, 21).kind).toBe("empty");
    expect(gapGauge(legalAnnouncements(null), null, null).kind).toBe("empty");
  });
});

describe("gapCopy", () => {
  it("names the cheapest claim and the climb in rungs", () => {
    const gauge = gapGauge(legalAnnouncements(62), 31, 62);
    expect(gapCopy(gauge)).toBe(
      "The cheapest legal claim is 6·3 — that's 11 rungs above what you're holding. There is no honest move left.",
    );
  });

  it("says one rung, not 1 rungs", () => {
    const gauge = gapGauge(legalAnnouncements(62), 62, 62);
    expect(gapCopy(gauge)).toBe(
      "The cheapest legal claim is 6·3 — that's one rung above what you're holding. There is no honest move left.",
    );
  });

  it("does not pretend an opener has a cut to climb", () => {
    const gauge = gapGauge([...RANKING], 54, null);
    expect(gapCopy(gauge)).toBe(
      "You open the round — any rung is legal. Your 5·4 is honest if you say it.",
    );
  });

  it("says when the held roll is itself legal", () => {
    const gauge = gapGauge(legalAnnouncements(62), 65, 62);
    expect(gapCopy(gauge)).toBe(
      "Your 6·5 is legal. The cheapest claim is 6·3 — say yours, or climb.",
    );
  });

  it("labels Mia as MIA, never 2·1", () => {
    expect(gapValueLabel(MIA)).toBe("MIA");
    const gauge = gapGauge(legalAnnouncements(66), 31, 66);
    expect(gauge.cheapest).toBe(MIA);
    expect(gapCopy(gauge)).toContain("MIA");
    expect(gapCopy(gauge)).not.toContain("2·1");
  });
});
