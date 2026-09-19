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
  it("is felt, the two token-only moods, and the two-colour press", () => {
    expect(MOOD_IDS).toEqual(["felt", "stammtisch", "night-shift", "press"]);
    expect(DEFAULT_MOOD).toBe("felt");
    expect(MOODS.map((mood) => mood.id)).toEqual([...MOOD_IDS]);
    expect(MOODS.find((mood) => mood.id === "press")?.label).toBe("Press");
  });

  it("treats only the allow-list as a mood and falls back to felt", () => {
    expect(isMoodId("felt")).toBe(true);
    expect(isMoodId("stammtisch")).toBe(true);
    expect(isMoodId("night-shift")).toBe(true);
    expect(isMoodId("press")).toBe(true);
    expect(isMoodId("")).toBe(false);
    expect(moodFromStorage("stammtisch")).toBe("stammtisch");
    expect(moodFromStorage("night-shift")).toBe("night-shift");
    expect(moodFromStorage("press")).toBe("press");
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
    expect(moodClassName("press")).toBe("mood-press");
    expect(moodClassNames()).toEqual(["mood-felt", "mood-stammtisch", "mood-night-shift", "mood-press"]);
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
    applyMoodClass(classList, "press");
    expect([...tokens].sort()).toEqual(["mood-press", "unrelated"]);
    applyMoodClass(classList, "felt");
    expect([...tokens].sort()).toEqual(["mood-felt", "unrelated"]);
  });

  it("keeps a theme-color per mood so the browser chrome can follow the tokens", () => {
    expect(themeColorFor("felt")).toBe("#0b3d2e");
    expect(themeColorFor("stammtisch")).toBe("#b98f5c");
    expect(themeColorFor("night-shift")).toBe("#0c0620");
    expect(themeColorFor("press")).toBe("#efeadf");
    expect(new Set(MOODS.map((mood) => mood.themeColor)).size).toBe(MOODS.length);
  });
});

describe("the press stylesheet", () => {
  it("is a token block plus component overrides, not tokens alone", () => {
    const css = readFileSync(join(root, "client/src/styles.css"), "utf8");
    expect(css).toContain(":root.mood-press");
    expect(css).toMatch(/:root\.mood-press,\s*body\.mood-press\s*\{[^}]*--radius:\s*0/);
    expect(css).toContain(":root.mood-press .card");
    expect(css).toContain(":root.mood-press .table-stage");
    expect(css).toContain(":root.mood-press .announce");
    expect(css).toContain(":root.mood-press .showdown-stamp");
    expect(css).toContain(":root.mood-press .film-cell");
    expect(css).toMatch(/:root\.mood-press \.card[\s\S]*box-shadow:\s*none/);
    expect(css).toMatch(/:root\.mood-press \.table-stage[\s\S]*border-radius:\s*0/);
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
      for (const mood of MOODS) {
        expect(source, `${name} themes ${mood.id}`).toMatch(
          new RegExp(`["']?${mood.id}["']?:\\s*"${mood.themeColor}"`),
        );
      }
    }
  });
});
