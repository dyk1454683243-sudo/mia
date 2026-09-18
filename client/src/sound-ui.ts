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
  if (on) {
    return `<svg class="sound-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M3 9v6h4l5 4V5L7 9H3z"/>
      <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M16 9.2a4.2 4.2 0 0 1 0 5.6M18.6 7a7.4 7.4 0 0 1 0 10"/>
    </svg>`;
  }
  return `<svg class="sound-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M3 9v6h4l5 4V5L7 9H3z"/>
    <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M16 8.5 21.5 16M21.5 8.5 16 16"/>
  </svg>`;
}

/** The top-bar control. `on` defaults to the stored preference. */
export function soundToggleHtml(on = readSoundPref()): string {
  const label = on ? "Sound on" : "Sound off";
  return `<button type="button" class="sound-toggle${on ? " on" : ""}" data-action="toggle-sound" aria-pressed="${
    on ? "true" : "false"
  }" aria-label="${label}" title="${label}">${speakerIcon(on)}</button>`;
}
