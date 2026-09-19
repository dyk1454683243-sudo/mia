/**
 * The personal mood catalog. The picker and the stylesheet are the other half;
 * this file pins the allow-list, the fallback, the body-class names, and that
 * the first-paint script in both HTML pages stays in lockstep with them.
 *
 * Why this is a `unit` test and not only `scripts/ui-check.ts`: the harness can
 * prove the picker writes localStorage, but it cannot fail a missing allow-list
 * entry or a boot script that moved below the stylesheet without reading the
 * source. The catalog is DOM-free on purpose.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOOD,
  MOOD_IDS,
  MOOD_STORAGE_KEY,
  MOODS,
  applyMoodClass,
  isMoodId,
  moodClassName,
  moodClassNames,
  moodFromStorage,
  themeColorFor,
} from "../src/shared/mood";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function htmlPages(): { name: string; source: string }[] {
  return ["client/index.html", "client/table.html"].map((name) => ({
    name,
    source: readFileSync(join(root, name), "utf8"),
  }));
}

describe("the mood catalog", () => {
  it("is felt plus the two token-only moods, and not the two-colour press", () => {
    expect(MOOD_IDS).toEqual(["felt", "stammtisch", "night-shift"]);
    expect(DEFAULT_MOOD).toBe("felt");
    expect(MOODS.map((mood) => mood.id)).toEqual([...MOOD_IDS]);
    expect(MOOD_IDS.includes("press" as (typeof MOOD_IDS)[number])).toBe(false);
  });

  it("treats only the allow-list as a mood and falls back to felt", () => {
    expect(isMoodId("felt")).toBe(true);
    expect(isMoodId("stammtisch")).toBe(true);
    expect(isMoodId("night-shift")).toBe(true);
    expect(isMoodId("press")).toBe(false);
    expect(isMoodId("")).toBe(false);
    expect(moodFromStorage("stammtisch")).toBe("stammtisch");
    expect(moodFromStorage("night-shift")).toBe("night-shift");
    expect(moodFromStorage("felt")).toBe("felt");
    expect(moodFromStorage(null)).toBe("felt");
    expect(moodFromStorage(undefined)).toBe("felt");
    expect(moodFromStorage("")).toBe("felt");
    expect(moodFromStorage("PRESS")).toBe("felt");
    expect(moodFromStorage("mood-stammtisch")).toBe("felt");
  });

  it("names one body class per mood so apply is a toggle, not a special case", () => {
    expect(moodClassName("felt")).toBe("mood-felt");
    expect(moodClassName("stammtisch")).toBe("mood-stammtisch");
    expect(moodClassName("night-shift")).toBe("mood-night-shift");
    expect(moodClassNames()).toEqual(["mood-felt", "mood-stammtisch", "mood-night-shift"]);
  });

  it("applies exactly one mood class at a time", () => {
    const tokens = new Set<string>(["mood-felt", "unrelated"]);
    const classList = {
      toggle: (token: string, force: boolean) => {
        if (force) tokens.add(token);
        else tokens.delete(token);
      },
    };
    applyMoodClass(classList, "stammtisch");
    expect([...tokens].sort()).toEqual(["mood-stammtisch", "unrelated"]);
    applyMoodClass(classList, "night-shift");
    expect([...tokens].sort()).toEqual(["mood-night-shift", "unrelated"]);
    applyMoodClass(classList, "felt");
    expect([...tokens].sort()).toEqual(["mood-felt", "unrelated"]);
  });

  it("keeps a theme-color per mood so the browser chrome can follow the tokens", () => {
    expect(themeColorFor("felt")).toBe("#0b3d2e");
    expect(themeColorFor("stammtisch")).toBe("#b98f5c");
    expect(themeColorFor("night-shift")).toBe("#0c0620");
    expect(new Set(MOODS.map((mood) => mood.themeColor)).size).toBe(MOODS.length);
  });
});

describe("the first-paint boot script", () => {
  it("lives inline, ahead of the stylesheet, in both pages", () => {
    for (const { name, source } of htmlPages()) {
      const keyAt = source.indexOf(MOOD_STORAGE_KEY);
      const cssAt = source.search(/styles\.css|rel="stylesheet"/);
      const moduleAt = source.indexOf('type="module"');
      expect(keyAt, `${name} stores under ${MOOD_STORAGE_KEY}`).toBeGreaterThan(-1);
      expect(cssAt, `${name} still links a stylesheet`).toBeGreaterThan(-1);
      expect(keyAt, `${name} applies the mood before the stylesheet`).toBeLessThan(cssAt);
      expect(source.slice(0, cssAt)).toContain("<script>");
      expect(source.slice(0, cssAt)).not.toContain('type="module"');
      expect(moduleAt, `${name} still has its page module`).toBeGreaterThan(cssAt);
      for (const id of MOOD_IDS) {
        expect(source, `${name} knows ${id}`).toContain(`mood-${id}`);
      }
    }
  });
});
