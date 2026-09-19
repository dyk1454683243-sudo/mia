/**
 * The lives indicator's number and its assistive name, pinned under Node.
 *
 * The view cannot be imported here (`client/src/table.ts` queries `#app` at
 * module scope). The property that matters is that the visible count and the
 * `aria-label` cannot disagree, which is why both are derived from one `lives`
 * argument in `src/shared/lives.ts`. `.pip.on` still counts the lives; this
 * file pins that the pip helper lights exactly that many.
 */
import { describe, expect, it } from "vitest";
import { STARTING_LIVES } from "../src/shared/mia";
import { lifePipOn, livesAriaLabel, livesCountText, livesIndicator } from "../src/shared/lives";

function leadingNumber(text: string): number {
  const match = /^(\d+)\b/.exec(text);
  if (match === null) throw new Error(`no leading number in ${JSON.stringify(text)}`);
  return Number(match[1]);
}

describe("livesIndicator", () => {
  it("derives the visible count and the aria-label from the same lives value", () => {
    for (let lives = 0; lives <= STARTING_LIVES; lives++) {
      const indicator = livesIndicator(lives);
      expect(indicator.lives, `${lives} lives field`).toBe(lives);
      expect(indicator.starting, `${lives} starting`).toBe(STARTING_LIVES);
      expect(leadingNumber(indicator.countText), `${lives} countText`).toBe(lives);
      expect(leadingNumber(indicator.ariaLabel), `${lives} ariaLabel`).toBe(lives);
      expect(indicator.countText, `${lives} countText string`).toBe(livesCountText(lives));
      expect(indicator.ariaLabel, `${lives} ariaLabel string`).toBe(livesAriaLabel(lives));
      expect(indicator.ariaLabel, `${lives} of-form`).toBe(`${lives} of ${STARTING_LIVES} lives`);
    }
  });

  it("uses the singular for one remaining life and the plural otherwise", () => {
    expect(livesCountText(1)).toBe("1 life");
    expect(livesCountText(0)).toBe("0 lives");
    expect(livesCountText(4)).toBe("4 lives");
    expect(livesCountText(STARTING_LIVES)).toBe(`${STARTING_LIVES} lives`);
  });

  it("keeps the seat aria-label in the form already on renderPlayers", () => {
    expect(livesAriaLabel(4)).toBe("4 of 6 lives");
    expect(livesAriaLabel(0)).toBe("0 of 6 lives");
    expect(livesAriaLabel(STARTING_LIVES)).toBe("6 of 6 lives");
  });
});

describe("lifePipOn", () => {
  it("lights exactly as many pips as the remaining lives", () => {
    for (let lives = 0; lives <= STARTING_LIVES; lives++) {
      const on = Array.from({ length: STARTING_LIVES }, (_, index) => lifePipOn(index, lives)).filter(Boolean);
      expect(on, `${lives} pips on`).toHaveLength(lives);
    }
  });

  it("does not invent a pip outside the starting row", () => {
    expect(lifePipOn(-1, 3)).toBe(false);
    expect(lifePipOn(STARTING_LIVES, STARTING_LIVES)).toBe(false);
  });
});
