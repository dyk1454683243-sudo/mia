/**
 * The empty-table screen's two extractable facts: how the join URL is split
 * for reading aloud, and when a practice shake is still in the air.
 *
 * `client/src/table.ts` cannot be imported under Node (it queries `#app` at
 * module scope), so the waiting room's load-bearing rules live here.
 */
import { describe, expect, it } from "vitest";
import { joinLink } from "../src/shared/join-link";
import { PRACTICE_ROLL_MS, practiceIsRolling } from "../src/shared/practice";

describe("joinLink", () => {
  it("prints the host without a scheme so it can be read aloud", () => {
    const link = joinLink("https://mia.example.workers.dev", "abc-def");
    expect(link.host).toBe("mia.example.workers.dev");
    expect(link.path).toBe("/t/abc-def");
    expect(link.href).toBe("https://mia.example.workers.dev/t/abc-def");
  });

  it("keeps the local port on the host", () => {
    expect(joinLink("http://127.0.0.1:8787", "t1").host).toBe("127.0.0.1:8787");
  });

  it("encodes a table id that is not a safe path segment", () => {
    const link = joinLink("https://mia.test", "a/b c");
    expect(link.path).toBe("/t/a%2Fb%20c");
    expect(link.href).toBe("https://mia.test/t/a%2Fb%20c");
  });

  it("does not double a trailing slash on the origin", () => {
    expect(joinLink("https://mia.test/", "id").href).toBe("https://mia.test/t/id");
  });
});

describe("practiceIsRolling", () => {
  it("is rolling before the 400ms beat is up", () => {
    expect(practiceIsRolling(1_000, 1_000 + PRACTICE_ROLL_MS - 1, false)).toBe(true);
  });

  it("has settled once the beat elapses", () => {
    expect(practiceIsRolling(1_000, 1_000 + PRACTICE_ROLL_MS, false)).toBe(false);
  });

  it("never rolls when the reader prefers reduced motion", () => {
    expect(practiceIsRolling(1_000, 1_000, true)).toBe(false);
  });
});
