/**
 * The closed-cup gate. The browser harness can see that a lid is on the
 * viewer's dice; it cannot cheaply plant a revealing-phase pair on that
 * same chair and prove the lid stayed off. The predicate is pure, so the
 * phase cut lives here.
 */
import { describe, expect, it } from "vitest";
import { cupCoversOwnDice } from "../src/shared/peek";
import type { Phase } from "../src/shared/mia";

const SECRET: Phase[] = ["roundStart", "deciding", "announcing"];
const OPEN: Phase[] = ["revealing", "finished"];

describe("cupCoversOwnDice", () => {
  it("covers the viewer's own pair only while the cup is still secret", () => {
    for (const phase of SECRET) {
      expect(cupCoversOwnDice(phase, true, true), phase).toBe(true);
    }
  });

  it("leaves a revealed or finished pair face-up, including the viewer's", () => {
    for (const phase of OPEN) {
      expect(cupCoversOwnDice(phase, true, true), phase).toBe(false);
    }
  });

  it("never covers another seat's dice, even in a secret phase", () => {
    for (const phase of [...SECRET, ...OPEN]) {
      expect(cupCoversOwnDice(phase, false, true), phase).toBe(false);
    }
  });

  it("does nothing when the snapshot did not send dice", () => {
    for (const phase of [...SECRET, ...OPEN]) {
      expect(cupCoversOwnDice(phase, true, false), phase).toBe(false);
    }
  });
});
