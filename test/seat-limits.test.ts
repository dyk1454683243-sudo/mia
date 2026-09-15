/**
 * The 2–8 seat limit must live in exactly one place: `src/shared/mia.ts`.
 *
 * Issue #8 was several copies of the same pair — the lobby, the Durable Object
 * cap, the start gate and the client copy — where changing one and missing
 * another is a silent mismatch. The behavioural tests in `test/room.test.ts`
 * cover the worker through real sockets; this guard only checks that each
 * consumer reads the shared constants rather than growing its own literal.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_PLAYERS, MIN_PLAYERS } from "../src/shared/mia";

const CONSUMERS = [
  "src/worker/index.ts",
  "src/worker/table-room.ts",
  "client/src/table.ts",
  "scripts/bots.ts",
];

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
}

describe("seat-limit constants", () => {
  it("keeps the canonical pair in the shared rules module", () => {
    expect(MIN_PLAYERS).toBe(2);
    expect(MAX_PLAYERS).toBe(8);
  });

  it("reads the limit from the shared constants", () => {
    for (const file of CONSUMERS) {
      expect(read(file), `${file} should reference the shared constants`).toMatch(/\b(?:MIN|MAX)_PLAYERS\b/);
    }
  });
});
