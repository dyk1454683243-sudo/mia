/**
 * The personal colour mood. A mood is a class on `<html>`/`<body>` plus a
 * token block in `client/src/styles.css`. Nothing about it is a table setting:
 * there is no server state and no agreement between players.
 *
 * The allow-list and the storage key are the contract the inline first-paint
 * script in `client/index.html` and `client/table.html` must stay in lockstep
 * with. A token-only mood is a new id here, a token block, and a line in that
 * script. The two-colour press is in this list too; it also needs the
 * component overrides in `styles.css`, because it inverts the dark-on-dark
 * assumptions the other moods keep.
 */
export const MOOD_STORAGE_KEY = "mia-mood";

export const DEFAULT_MOOD = "felt";

export const MOOD_IDS = ["felt", "stammtisch", "night-shift", "press"] as const;

export type MoodId = (typeof MOOD_IDS)[number];

export interface MoodSpec {
  id: MoodId;
  label: string;
  /** Browser chrome (`theme-color`) for this mood. */
  themeColor: string;
}

export const MOODS: readonly MoodSpec[] = [
  { id: "felt", label: "Felt", themeColor: "#0b3d2e" },
  { id: "stammtisch", label: "Stammtisch", themeColor: "#b98f5c" },
  { id: "night-shift", label: "Night Shift", themeColor: "#0c0620" },
  { id: "press", label: "Press", themeColor: "#efeadf" },
];

export function isMoodId(value: string): value is MoodId {
  return (MOOD_IDS as readonly string[]).includes(value);
}

/** Unknown, empty or hostile values fall back to the shipped felt. */
export function moodFromStorage(value: string | null | undefined): MoodId {
  return value != null && isMoodId(value) ? value : DEFAULT_MOOD;
}

export function moodClassName(mood: MoodId): string {
  return `mood-${mood}`;
}

export function moodClassNames(): readonly string[] {
  return MOOD_IDS.map(moodClassName);
}

export function themeColorFor(mood: MoodId): string {
  const spec = MOODS.find((entry) => entry.id === mood);
  return spec?.themeColor ?? MOODS[0]!.themeColor;
}

/**
 * Exactly one `mood-*` class. The default is a real class rather than the
 * absence of one, so a switch back to felt is a toggle, not a special case.
 */
export function applyMoodClass(
  classList: { toggle: (token: string, force: boolean) => void },
  mood: MoodId,
): void {
  for (const id of MOOD_IDS) {
    classList.toggle(moodClassName(id), id === mood);
  }
}
