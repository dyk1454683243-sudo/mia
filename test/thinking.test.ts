/**
 * The thinking ellipsis is a client-only tell, but the rule that decides
 * whether a seat gets one is a predicate of `turn`, `offline` and
 * `eliminated`. That lives in `src/shared/thinking.ts` so it can be pinned
 * under plain Node: `client/src/table.ts` queries `#app` at import, and the
 * browser harness never drops a bot mid-turn, so it cannot reach the
 * offline-versus-thinking collision at all.
 *
 * The load-bearing property is the offline exclusion. A seat that is on the
 * clock and disconnected must not look like a long think.
 */
import { describe, expect, it } from "vitest";
import { seatIsThinking } from "../src/shared/thinking";

describe("seatIsThinking", () => {
  it("marks the active connected seat as thinking", () => {
    expect(seatIsThinking({ turn: true, offline: false, eliminated: false })).toBe(true);
  });

  it("leaves every other seat still", () => {
    expect(seatIsThinking({ turn: false, offline: false, eliminated: false })).toBe(false);
    expect(seatIsThinking({ turn: false, offline: true, eliminated: false })).toBe(false);
    expect(seatIsThinking({ turn: false, offline: false, eliminated: true })).toBe(false);
  });

  it("reads an offline seat on its own turn as offline, not thinking", () => {
    expect(seatIsThinking({ turn: true, offline: true, eliminated: false })).toBe(false);
  });

  it("never thinks from an eliminated chair", () => {
    expect(seatIsThinking({ turn: true, offline: false, eliminated: true })).toBe(false);
    expect(seatIsThinking({ turn: true, offline: true, eliminated: true })).toBe(false);
  });
});
