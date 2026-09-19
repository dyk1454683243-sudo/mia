/**
 * Browser wiring for the personal mood: localStorage, the body class, and the
 * picker markup. The catalog itself is DOM-free in `src/shared/mood.ts`.
 */
import {
  DEFAULT_MOOD,
  MOOD_STORAGE_KEY,
  MOODS,
  applyMoodClass,
  moodFromStorage,
  themeColorFor,
  type MoodId,
} from "../../src/shared/mood";

export { MOOD_STORAGE_KEY, moodFromStorage, type MoodId };

export function readStoredMood(): MoodId {
  try {
    return moodFromStorage(window.localStorage.getItem(MOOD_STORAGE_KEY));
  } catch {
    return DEFAULT_MOOD;
  }
}

export function writeStoredMood(mood: MoodId): void {
  try {
    window.localStorage.setItem(MOOD_STORAGE_KEY, mood);
  } catch {
    // Private mode, a full quota — the class still applies for this load.
  }
}

export function applyMood(mood: MoodId): void {
  applyMoodClass(document.documentElement.classList, mood);
  document.documentElement.dataset.mood = mood;
  if (document.body) applyMoodClass(document.body.classList, mood);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", themeColorFor(mood));
}

/** Compact `<select>` for the sticky topbar on both pages. */
export function moodPickerMarkup(selected: MoodId = readStoredMood()): string {
  const options = MOODS.map(
    (mood) =>
      `<option value="${mood.id}"${mood.id === selected ? " selected" : ""}>${mood.label}</option>`,
  ).join("");
  return `<label class="mood-picker"><span class="vh">Mood</span><select data-mood-picker aria-label="Mood">${options}</select></label>`;
}

let booted = false;

/**
 * Re-apply the stored mood (the inline HTML script already did this before
 * first paint) and listen for picker changes. Safe to call from both pages.
 */
export function bootMood(): void {
  applyMood(readStoredMood());
  if (booted) return;
  booted = true;
  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || !target.matches("[data-mood-picker]")) return;
    const mood = moodFromStorage(target.value);
    writeStoredMood(mood);
    applyMood(mood);
    for (const other of document.querySelectorAll<HTMLSelectElement>("[data-mood-picker]")) {
      other.value = mood;
    }
  });
}
