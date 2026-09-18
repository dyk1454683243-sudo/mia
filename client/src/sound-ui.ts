/**
 * The speaker toggle markup and the localStorage read/write. Kept out of
 * `sound.ts` so the lobby can draw the control without pulling the three
 * samples into its bundle — those files only load on the table page, and only
 * once sound is actually on.
 */
import { isSoundOn, SOUND_STORAGE_KEY, soundStorageValue } from "../../src/shared/sound-pref";

export function readSoundPref(): boolean {
  try {
    return isSoundOn(localStorage.getItem(SOUND_STORAGE_KEY));
  } catch {
    return false;
  }
}

export function writeSoundPref(on: boolean): void {
  try {
    localStorage.setItem(SOUND_STORAGE_KEY, soundStorageValue(on));
  } catch {
    /* private mode: the toggle still works for this page load */
  }
}

function speakerIcon(on: boolean): string {
  // A large cone so the control reads as a speaker at 44px, not a punctuation
  // mark. Off is the same cone with a slash through it; on adds the waves.
  const cone = `<path fill="currentColor" d="M3.5 9.2v5.6h3.4L14 20.2V3.8L6.9 9.2H3.5z"/>`;
  if (on) {
    return `<svg class="sound-icon" viewBox="0 0 24 24" aria-hidden="true">
      ${cone}
      <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16.2 9a4.4 4.4 0 0 1 0 6M18.8 6.6a7.6 7.6 0 0 1 0 10.8"/>
    </svg>`;
  }
  return `<svg class="sound-icon" viewBox="0 0 24 24" aria-hidden="true">
    ${cone}
    <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M5 5l14 14"/>
  </svg>`;
}

/** The top-bar control. `on` defaults to the stored preference. */
export function soundToggleHtml(on = readSoundPref()): string {
  const label = on ? "Sound on" : "Sound off";
  return `<button type="button" class="sound-toggle${on ? " on" : ""}" data-action="toggle-sound" aria-pressed="${
    on ? "true" : "false"
  }" aria-label="${label}" title="${label}">${speakerIcon(on)}</button>`;
}
