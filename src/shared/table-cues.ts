/**
 * Snapshot transitions that fire the optional delights — sound now, haptics
 * when that item lands. Both read this module so a reconnect, a mid-turn
 * broadcast or a spectator view cannot start buzzing one and not the other.
 *
 * Fire on the *transition*, never on the state. `render` runs on every
 * snapshot and a reconnect replays the current one, so a check written against
 * "it is your turn" would rattle the cup for a turn that started ten minutes
 * ago. The first snapshot a tracker sees is a baseline and produces nothing.
 */
import { playerById, type MiaState } from "./mia";

/**
 * The three haptic events, plus `reveal` so the thud can play for everyone at
 * the table (including a successful doubter who lost no life). Haptics will
 * ignore `reveal` and keep using the personal three.
 */
export type TableCue = "your-turn" | "doubted" | "life-lost" | "reveal";

export interface CueSnap {
  you: string;
  turnPlayerId: string | null;
  pendingDoubtAnnouncerId: string | null;
  /** Identity of the live reveal, or null once it has been cleared. */
  revealKey: string | null;
  yourLives: number | null;
}

function revealKeyOf(state: MiaState): string | null {
  const reveal = state.pendingDoubt;
  if (!reveal) return null;
  return `${reveal.announcerId}:${reveal.doubterId}:${reveal.announced}:${reveal.actual}:${state.round}`;
}

export function cueSnapOf(state: MiaState, you: string): CueSnap {
  return {
    you,
    turnPlayerId: state.turnPlayerId,
    pendingDoubtAnnouncerId: state.pendingDoubt?.announcerId ?? null,
    revealKey: revealKeyOf(state),
    yourLives: playerById(state, you)?.lives ?? null,
  };
}

/**
 * Cues that became true between `prev` and `next`. A missing `prev` is the
 * first snapshot after a connect (or a reconnect): history, not an event.
 * A change of `you` is treated the same way — it is a different viewer, not
 * a transition in this one's game.
 */
export function cuesBetween(prev: CueSnap | null, next: CueSnap): TableCue[] {
  if (prev === null || prev.you !== next.you) return [];
  const cues: TableCue[] = [];
  if (next.turnPlayerId === next.you && prev.turnPlayerId !== next.you) {
    cues.push("your-turn");
  }
  if (next.pendingDoubtAnnouncerId === next.you && prev.pendingDoubtAnnouncerId !== next.you) {
    cues.push("doubted");
  }
  if (next.yourLives !== null && prev.yourLives !== null && next.yourLives < prev.yourLives) {
    cues.push("life-lost");
  }
  if (next.revealKey !== null && next.revealKey !== prev.revealKey) {
    cues.push("reveal");
  }
  return cues;
}

/** Remembers the last snap so a page can ask "what just happened?" */
export class CueTracker {
  private prev: CueSnap | null = null;

  observe(state: MiaState, you: string): TableCue[] {
    const next = cueSnapOf(state, you);
    const cues = cuesBetween(this.prev, next);
    this.prev = next;
    return cues;
  }

  /** Drop the baseline so the next snapshot is treated as a reconnect. */
  reset(): void {
    this.prev = null;
  }
}
