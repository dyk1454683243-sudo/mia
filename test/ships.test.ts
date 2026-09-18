/**
 * Culture ship-name draws. The failure these pin: a reroll that treats table
 * names as ordinary `taken` names reuses one once the recent pool is full, and
 * two seats at the same table end up called the same thing.
 */
import { describe, expect, it } from "vitest";
import { pickShipName, SHIP_NAMES } from "../src/shared/ships";

describe("pickShipName", () => {
  it("never returns a taken name while any ship is free", () => {
    const taken = SHIP_NAMES.slice(0, -1);
    const only = SHIP_NAMES[SHIP_NAMES.length - 1]!;
    for (let i = 0; i < 40; i++) {
      expect(pickShipName(taken)).toBe(only);
    }
  });

  it("reuses a taken name once the free pool is empty", () => {
    const name = pickShipName(SHIP_NAMES);
    expect(SHIP_NAMES).toContain(name);
  });

  it("never returns a reserved name while any other ship exists, even when every name is taken", () => {
    // Soft-taken covers the whole pool, so the first filter is empty and the
    // fallback is what has to honour `reserved`. Ignoring reserved here is
    // exactly "seat two identical names".
    const reserved = SHIP_NAMES.slice(0, -1);
    const only = SHIP_NAMES[SHIP_NAMES.length - 1]!;
    for (let i = 0; i < 40; i++) {
      expect(pickShipName(SHIP_NAMES, { reserved })).toBe(only);
    }
  });

  it("will not hand you the name you already have while another ship exists", () => {
    const current = SHIP_NAMES[0]!;
    for (let i = 0; i < 40; i++) {
      expect(pickShipName([], { reserved: [current] })).not.toBe(current);
    }
  });
});
