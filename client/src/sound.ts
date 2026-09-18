/**
 * The three table samples. Nothing here constructs an `Audio` object while
 * sound is off — a fresh visitor in a quiet room must hear nothing, and a
 * toggle-off must drop the objects it created.
 *
 * The files are imported so `vite build` emits hashed URLs under `dist/client`.
 * `publicDir` is off, so dropping them in `client/` without an import would
 * leave them out of the bundle and 404 at play time.
 */
import type { TableCue } from "../../src/shared/table-cues";
import { readSoundPref, writeSoundPref } from "./sound-ui";
import cupRattleUrl from "./sounds/cup-rattle.wav?url";
import dieOnWoodUrl from "./sounds/die-on-wood.wav?url";
import revealThudUrl from "./sounds/reveal-thud.wav?url";

export type SoundSample = "cup" | "wood" | "thud";

const SAMPLE_URL: Record<SoundSample, string> = {
  cup: cupRattleUrl,
  wood: dieOnWoodUrl,
  thud: revealThudUrl,
};

/** One sample per cue. `life-lost` and `reveal` share the thud; play() dedupes. */
export const SAMPLE_FOR_CUE: Record<TableCue, SoundSample> = {
  "your-turn": "cup",
  doubted: "wood",
  "life-lost": "thud",
  reveal: "thud",
};

function prepare(src: string): HTMLAudioElement {
  const element = new Audio(src);
  element.preload = "auto";
  element.load();
  return element;
}

export class TableSound {
  private elements: Partial<Record<SoundSample, HTMLAudioElement>> | null = null;
  private unlocked = false;

  enabled(): boolean {
    return readSoundPref();
  }

  /** True only after `ensure` has built the three `Audio` objects. */
  constructed(): boolean {
    return this.elements !== null;
  }

  setEnabled(on: boolean): void {
    writeSoundPref(on);
    if (on) {
      this.ensure();
      void this.unlock();
      return;
    }
    this.dispose();
  }

  /** Build and preload without playing — used when a returning visitor already opted in. */
  preload(): void {
    if (!this.enabled()) return;
    this.ensure();
  }

  /** The toggle is the gesture that unlocks autoplay; a reload needs another tap. */
  unlockFromGesture(): void {
    if (!this.enabled()) return;
    this.ensure();
    void this.unlock();
  }

  play(cues: TableCue[]): void {
    if (!this.enabled() || !this.elements || cues.length === 0) return;
    const samples = new Set(cues.map((cue) => SAMPLE_FOR_CUE[cue]));
    for (const sample of samples) {
      const element = this.elements[sample];
      if (!element) continue;
      element.currentTime = 0;
      void element.play().catch(() => {
        /* still locked; the next gesture will unlock */
      });
    }
  }

  private ensure(): void {
    if (this.elements) return;
    this.elements = {
      cup: prepare(SAMPLE_URL.cup),
      wood: prepare(SAMPLE_URL.wood),
      thud: prepare(SAMPLE_URL.thud),
    };
  }

  private dispose(): void {
    if (!this.elements) return;
    for (const element of Object.values(this.elements)) {
      if (!element) continue;
      element.pause();
      element.removeAttribute("src");
      element.src = "";
      element.load();
    }
    this.elements = null;
    this.unlocked = false;
  }

  private async unlock(): Promise<void> {
    if (!this.elements || this.unlocked) return;
    await Promise.all(
      Object.values(this.elements).map(async (element) => {
        if (!element) return;
        element.muted = true;
        try {
          await element.play();
        } catch {
          /* autoplay still blocked; unlockFromGesture will try again */
        }
        element.pause();
        element.currentTime = 0;
        element.muted = false;
      }),
    );
    this.unlocked = true;
  }
}

export const tableSound = new TableSound();
