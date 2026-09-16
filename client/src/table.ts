/**
 * Table page: one render function over the latest server snapshot.
 * All hidden-dice redaction happens server-side; this file only draws.
 */
import {
  formatValue,
  isDouble,
  legalMoves,
  MAX_PLAYERS,
  MIA,
  MIN_PLAYERS,
  playerById,
  RANKING,
  rollValue,
  STARTING_LIVES,
  type Announcement,
  type Die,
  type DoubtReveal,
  type MiaPlayer,
  type MiaState,
} from "../../src/shared/mia";
import type { ClientMessage, StateView, TableSummary } from "../../src/shared/protocol";
import { TurnClock } from "../../src/shared/clock";
import { seatPositions } from "../../src/shared/seat-positions";
import {
  showdownLoser,
  showdownSentence,
  showdownStamp,
  showdownTiming,
  showdownTone,
  showdownValue,
} from "../../src/shared/showdown";
import { api, escapeHtml, TableSocket } from "./net";

const PIPS: Record<number, string[]> = {
  1: ["c"],
  2: ["tl", "br"],
  3: ["tl", "c", "br"],
  4: ["tl", "tr", "bl", "br"],
  5: ["tl", "tr", "c", "bl", "br"],
  6: ["tl", "tr", "ml", "mr", "bl", "br"],
};

function dieFace(value: number, size: "sm" | "lg"): string {
  const pips = PIPS[value] ?? [];
  return `<span class="die ${size}" role="img" aria-label="${value}">${pips
    .map((pip) => `<i class="${pip}"></i>`)
    .join("")}</span>`;
}

function diceOf(player: MiaPlayer | undefined, size: "sm" | "lg" = "lg"): string {
  if (!player || !player.dice) {
    return `<span class="dice"><span class="die ${size} hidden">?</span><span class="die ${size} hidden">?</span></span>`;
  }
  return `<span class="dice">${dieFace(player.dice[0], size)}${dieFace(player.dice[1], size)}</span>`;
}

function valueChip(value: number, extra = ""): string {
  const mia = value === MIA;
  const label = mia ? "MIA" : formatValue(value);
  const double = isDouble(value) && !mia;
  return `<span class="chip ${mia ? "mia" : ""} ${double ? "double" : ""} ${extra}">${label}</span>`;
}

/** A roll value as it should read in prose: 21 is "MIA", never "2·1". */
function valueLabel(value: number): string {
  return showdownValue(value);
}

/**
 * The verdict sentence is built in `src/shared/showdown.ts` so its facts — the
 * MIA label, the player charged, the double penalty — are unit-tested rather
 * than only seen in a random browser game. The class is what the CSS and the
 * harness read to tell a caught bluff from a believed claim.
 */
function verdictLine(reveal: DoubtReveal): string {
  const verdict = reveal.verdict === "announcer" ? "caught" : "believed";
  return `<p class="verdict ${verdict}">${showdownSentence(reveal)}</p>`;
}

/** The two physical dice behind a roll value, largest face first. */
function rolledDice(value: number): string {
  const hi = Math.floor(value / 10);
  const lo = value % 10;
  return `<span class="dice">${dieFace(hi, "lg")}${dieFace(lo, "lg")}</span>`;
}

/**
 * The reveal staged as a full-screen showdown, in three beats driven by the
 * server's reveal window: the cup lifts, the dice tumble and settle, the stamp
 * lands. Claimed and actual sit side by side so the comparison is the picture,
 * and `.verdict` underneath only names it.
 *
 * The beats are fractions of `deadlineAt - turnStartedAt` (the server's
 * `revealMs`), never a fixed animation length, so a shortened test clock
 * compresses the staging with it. `--showdown-elapsed` is handed to CSS as a
 * *negative animation-delay* so a snapshot that rebuilds this subtree mid-beat
 * resumes at the frame already on screen instead of restarting at beat one.
 *
 * `.reveal`, `.reveal-dice` and `.verdict` keep the exact meaning
 * `scripts/ui-check.ts` reads: their presence is the `revealing` phase, the
 * claim and the actual dice, and the factual one-liner.
 */
function renderShowdown(game: MiaState, view: StateView, reveal: DoubtReveal): string {
  const stamp = showdownStamp(reveal);
  const tone = showdownTone(reveal);
  const loser = showdownLoser(reveal);
  const timing = showdownTiming(game.turnStartedAt, game.deadlineAt, clock.now());
  const remaining = clock.secondsLeft(game.deadlineAt) ?? 0;
  const loserPlayer = playerById(game, loser.id);
  const lives = Array.from(
    { length: STARTING_LIVES },
    (_, life) => (life < (loserPlayer?.lives ?? 0) ? '<i class="pip on"></i>' : '<i class="pip"></i>'),
  ).join("");
  const living = game.players
    .filter((player) => !player.eliminated)
    .map(
      (player) =>
        `<span class="showdown-chip${player.id === view.you ? " you" : ""}"><span class="avatar" aria-hidden="true">${escapeHtml(
          initialsOf(player.name),
        )}</span>${escapeHtml(player.name)}</span>`,
    )
    .join("");
  const next =
    loserPlayer && !loserPlayer.eliminated
      ? `${loser.name} starts the next round.`
      : "The next player starts the next round.";
  // The identity of this particular reveal, so a rebuilt subtree can be told
  // apart from a genuinely new one. `--showdown-elapsed` is what CSS actually
  // resumes from; the key is the stable handle on the same showdown.
  const key = `${reveal.announcerId}:${reveal.doubterId}:${reveal.announced}:${reveal.actual}:${game.round}`;
  return `<section class="showdown reveal ${tone} beat-${timing.beat}${
    timing.done ? " done" : ""
  }" data-reveal-key="${escapeHtml(key)}" style="--showdown-span:${timing.span}ms;--showdown-elapsed:${timing.elapsed}ms">
    <div class="showdown-panel">
      <header class="showdown-top">
        <span class="brand">Mia</span>
        <span class="showdown-table">${escapeHtml(view.state.tableName)}</span>
        <span class="round">Round ${game.round}</span>
      </header>
      <div class="showdown-body">
        <p class="showdown-who">
          <span class="avatar" aria-hidden="true">${escapeHtml(initialsOf(reveal.doubterName))}</span>
          <span class="showdown-verb">doubted</span>
          <span class="avatar" aria-hidden="true">${escapeHtml(initialsOf(reveal.announcerName))}</span>
        </p>
        <div class="reveal-dice showdown-compare">
          <div class="showdown-side showdown-claimed">
            <p class="label">claimed</p>
            ${valueChip(reveal.announced, "showdown-value")}
          </div>
          <span class="showdown-vs" aria-hidden="true">vs</span>
          <div class="showdown-side showdown-actual">
            <p class="label">actually</p>
            <div class="showdown-dice-wrap">
              ${rolledDice(reveal.actual)}
              <div class="showdown-cup" aria-hidden="true"></div>
            </div>
          </div>
        </div>
        <div class="showdown-stamp-wrap"><span class="showdown-stamp">${stamp}</span></div>
        ${verdictLine(reveal)}
        <p class="showdown-loss"><b>−${loser.livesLost}</b> ${escapeHtml(loser.name)}<span class="pips">${lives}</span></p>
        <p class="showdown-next">${escapeHtml(next)}</p>
        <div class="showdown-still"><span class="label">Still in</span>${living}</div>
      </div>
      <p class="showdown-timer" role="status">Deal the next round · <span data-countdown>${remaining}s</span></p>
    </div>
  </section>`;
}

/**
 * A compact, static version of the same comparison for the reveal that has no
 * window to stage over. `resolveDoubt` sets `phase = "revealing"` with a
 * deadline, but its trailing `resolveEliminations` call flips a doubt that ends
 * the game to `finished` and clears `deadlineAt` in that same invocation, before
 * any snapshot can carry a revealing phase. The finished screen therefore
 * renders this recap, keeping the `.reveal`/`.reveal-dice`/`.verdict` contract.
 */
function renderRevealCard(reveal: DoubtReveal): string {
  const tone = showdownTone(reveal);
  return `<section class="card standing-card reveal-card ${tone}">
    <p class="label">Last claim</p>
    <div class="reveal">
      <div class="reveal-dice">
        <div><p class="label">claimed</p>${valueChip(reveal.announced)}</div>
        <div><p class="label">actual</p>${valueChip(reveal.actual, "actual")}</div>
      </div>
      <span class="showdown-stamp compact">${showdownStamp(reveal)}</span>
      ${verdictLine(reveal)}
    </div>
  </section>`;
}

interface PageState {
  table: TableSummary | null;
  view: StateView | null;
  error: string | null;
  /** A terminal reason this client will never get a seat; stops reconnecting. */
  fatal: string | null;
  lastCountdown: number | null;
}

const app = document.querySelector<HTMLElement>("#app")!;
const tableId = location.pathname.startsWith("/t/") ? decodeURIComponent(location.pathname.slice(3)) : "";
const state: PageState = { table: null, view: null, error: null, fatal: null, lastCountdown: null };
/** Drift is captured when a snapshot lands, then reused for every tick. */
const clock = new TurnClock();
let socket: TableSocket | null = null;

function send(message: ClientMessage): void {
  // Stamp the snapshot this move was decided against. A move queued during a
  // disconnect is replayed on reconnect by `TableSocket`, and by then the table
  // may be several turns on; the server refuses a stamp that no longer matches.
  const logSeq = state.view?.state.logSeq;
  socket?.send(logSeq === undefined ? message : { ...message, logSeq });
}

async function share(): Promise<void> {
  const url = `${location.origin}/t/${tableId}`;
  const title = state.table ? `Mia at ${state.table.name}` : "Mia";
  try {
    if (navigator.share) {
      await navigator.share({ title, url, text: `Join my Mia table: ${title}` });
      return;
    }
    await navigator.clipboard.writeText(url);
    toast("Join link copied.");
  } catch {
    toast(url);
  }
}

let toastTimer: number | null = null;
function toast(message: string): void {
  state.error = message;
  render();
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    state.error = null;
    render();
  }, 4_000);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderWaiting(view: StateView): string {
  const players = view.state.players;
  // The creator is whoever D1 recorded, not whoever opened a socket first.
  const hostId = view.state.hostId ?? players[0]?.id ?? null;
  const host = players.find((player) => player.id === hostId);
  const hostHere = hostId !== null && view.connected.includes(hostId);
  const isHost = hostId !== null && hostId === view.you;
  // If the creator is not around, anyone seated may start (B5's case).
  const canStart = isHost || !hostHere;
  const enough = players.length >= MIN_PLAYERS;
  const rows = players
    .map(
      (player, index) => `<li class="roster-row">
        <span class="seat">${index + 1}</span>
        <span class="name">${escapeHtml(player.name)}${player.id === view.you ? " <em>(you)</em>" : ""}</span>
        ${player.id === hostId ? '<span class="badge">opened</span>' : ""}
        ${view.connected.includes(player.id) ? "" : '<span class="badge muted">offline</span>'}
      </li>`,
    )
    .join("");

  const controls = canStart
    ? `<button class="primary big" data-action="start" ${enough ? "" : "disabled"}>
         ${enough ? "Start the game" : `Waiting for at least ${MIN_PLAYERS} players…`}
       </button>`
    : `<p class="waiting-line">Waiting for ${escapeHtml(host?.name ?? "the table's creator")} to start…</p>`;
  const hostAway =
    !isHost && !hostHere
      ? `<p class="muted small">The table's creator is away — anyone here can start it.</p>`
      : "";

  return `
    <section class="card room-card">
      <h2>${escapeHtml(state.table?.name ?? view.state.tableName)}</h2>
      <p class="muted">${players.length} of ${MAX_PLAYERS} seats taken · ${STARTING_LIVES} lives each</p>
      <ul class="roster">${rows}</ul>
      ${controls}
      ${hostAway}
      <div class="row gap">
        <button class="ghost" data-action="share">Share join link</button>
        <a class="ghost link" href="/">Back to lobby</a>
      </div>
    </section>`;
}

/** Two-letter initials for the seat avatar: first letters of the first two words. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "··";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]!}${words[1]![0]!}`.toUpperCase();
}

/**
 * The table in the round: seats on the felt with the standing claim dead centre.
 *
 * The DOM keeps the contract the harness relies on — each seat is a `.player`
 * with `.name` (and `.name em` for the viewer), `.player-dice` only when the
 * snapshot actually carries dice, a `.badge.cup`, the `turn`/`out` classes on
 * the seat, and one `.pip.on` per life. The claim is a text speech bubble on the
 * seat that made it, never dice, so the secrecy rule is untouched.
 */
function renderPlayers(game: MiaState, view: StateView): string {
  const countdown = clock.secondsLeft(game.deadlineAt);
  const players = game.players;
  const viewerIndex = Math.max(
    0,
    players.findIndex((player) => player.id === view.you),
  );
  const positions = seatPositions(players.length, viewerIndex);
  const claim = game.lastAnnouncement;

  const seats = players
    .map((player, index) => {
      const turn = game.turnPlayerId === player.id;
      const cup = game.diceOwnerId === player.id && game.phase !== "finished";
      const offline = !view.connected.includes(player.id);
      const isYou = player.id === view.you;
      const ownTurn = turn && isYou && countdown !== null;
      const lives = Array.from({ length: STARTING_LIVES }, (_, life) =>
        life < player.lives ? '<i class="pip on"></i>' : '<i class="pip"></i>',
      ).join("");
      const { x, y } = positions[index]!;
      // A bubble hangs on the claimant's chair, so a claim repeated round after
      // round is visible at their seat instead of remembered from the log.
      const showClaim = claim !== null && claim.playerId === player.id;
      return `<li class="player${turn ? " turn" : ""}${player.eliminated ? " out" : ""}${
        isYou ? " you" : ""
      }" data-player-id="${escapeHtml(player.id)}" style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%">
        <span class="avatar" aria-hidden="true">${escapeHtml(initialsOf(player.name))}</span>
        <span class="name">${escapeHtml(player.name)}${isYou ? " <em>(you)</em>" : ""}</span>
        <span class="tag-row">
          ${player.eliminated ? '<span class="badge out">out</span>' : ""}
          ${cup ? '<span class="badge cup">cup</span>' : ""}
          ${turn ? '<span class="badge turn">turn</span>' : ""}
          ${ownTurn ? `<span class="badge countdown" data-countdown>${countdown}s</span>` : ""}
          ${offline && !player.eliminated ? '<span class="badge muted">offline</span>' : ""}
        </span>
        <div class="pips" aria-label="${player.lives} of ${STARTING_LIVES} lives">${lives}</div>
        ${player.dice ? `<div class="player-dice">${diceOf(player, "sm")}</div>` : ""}
        ${
          showClaim
            ? `<span class="claim" data-claim-player="${escapeHtml(player.id)}">${valueLabel(claim.value)}</span>`
            : ""
        }
      </li>`;
    })
    .join("");

  // The standing claim is the page-level `.standing` the harness reads; it just
  // lives in the middle of the felt now. `data-claimer-id` lets the harness tie
  // the centre chip to the bubble on the claimant's seat without reading the
  // ladder, keeping the two sources independent.
  const centre = `<div class="table-centre">
      <p class="label">Standing</p>
      <div class="standing"${
        claim ? ` data-claimer-id="${escapeHtml(claim.playerId)}"` : ""
      }>${claim ? valueChip(claim.value) : '<span class="muted">nothing yet</span>'}</div>
      <p class="muted small">${claim ? `claimed by ${escapeHtml(claim.playerName)}` : "no claim yet"}</p>
    </div>`;

  return `<section class="card table-card">
    <div class="table-stage">
      <ul class="players" data-seat-count="${players.length}">${seats}</ul>
      ${centre}
    </div>
  </section>`;
}

interface Rung {
  isLegal: boolean;
  isMine: boolean;
  isStanding: boolean;
  /** The cheapest claim, one rung above the standing value. */
  isCheapest: boolean;
  standing: Announcement | null;
}

/**
 * Short, engine-true hints for a rung. Every claim here is checked against
 * `src/shared/mia.ts`:
 *
 * - `isDouble` marks the pairs, and `RANKING` puts every double above every
 *   mixed roll, so `11` really does beat all of them.
 * - `65` is the highest-ranked mixed roll in `RANKING`.
 * - `resolveDoubt` computes `isMiaTrap = announced === MIA && actual === MIA`,
 *   which costs `livesLost = 2` and charges the *doubter* — never the announcer.
 */
function rungHint(value: number, rung: Rung): string {
  const hints: string[] = [];
  if (value === MIA) {
    hints.push("beats everything");
    hints.push("doubting a real Mia costs 2");
  } else if (value === 11) {
    hints.push("double");
    hints.push("beats every mixed roll");
  } else if (isDouble(value)) {
    hints.push("double");
  } else if (value === 65) {
    hints.push("highest mixed roll");
  }
  if (rung.isCheapest) hints.push("one rung up");
  if (rung.isStanding && rung.standing) hints.push(`standing · ${rung.standing.playerName}`);
  if (rung.isMine) hints.push(rung.isLegal ? "yours" : "in your cup");
  return hints.join(" · ");
}

function renderRung(value: number, rung: Rung): string {
  const label = value === MIA ? "MIA" : formatValue(value);
  const classes = ["announce"];
  if (value === MIA) classes.push("mia");
  if (rung.isMine) classes.push("mine");
  if (rung.isStanding) classes.push("rung-standing");
  // A real `disabled` attribute, not just a class: an illegal claim must be
  // untappable and unfocusable, which is also what the browser harness probes.
  const disabled = rung.isLegal ? "" : " disabled";
  return `<button class="${classes.join(" ")}" data-action="announce" data-value="${value}"${disabled}>
      <span class="rung-value">${label}</span>
      <span class="rung-hint">${escapeHtml(rungHint(value, rung))}</span>
    </button>`;
}

/**
 * The ranking as one vertical ladder, highest (`21`/Mia) at the top and `31` at
 * the bottom. Every rung comes from `RANKING`, and tappability is membership in
 * `announcements` — the engine's `legalMoves` — never a numeric comparison:
 * `11` outranks `65` even though `11 > 65` is false.
 *
 * The standing claim is a cut line. Rungs at or below it are dimmed with a real
 * `disabled` attribute, while the rung the player holds stays visible below the
 * cut so they can see how far they have to climb.
 */
function renderAnnounceLadder(
  announcements: number[],
  myDice: [Die, Die] | null,
  standing: Announcement | null,
): string {
  // `rollValue` normalises the dice order; the raw `d[0] * 10 + d[1]` misses
  // whenever the lower die comes up first, so "yours" would vanish half the time.
  const mineValue = myDice ? rollValue(myDice[0], myDice[1]) : null;
  const legal = new Set(announcements);
  // `legalAnnouncements` preserves `RANKING` order, so the last legal value is
  // the cheapest claim, exactly one rung above the standing one.
  const cheapest = announcements.length > 0 ? announcements[announcements.length - 1]! : null;
  const rungs: string[] = [];

  for (const value of RANKING) {
    const isStanding = standing !== null && standing.value === value;
    if (isStanding) {
      // The cut is drawn immediately above the standing claim. Text plus a
      // dashed rule, so the boundary is not colour-only.
      rungs.push('<div class="ladder-cut"><span>MUST BEAT</span></div>');
    }
    rungs.push(
      renderRung(value, {
        isLegal: legal.has(value),
        isMine: value === mineValue,
        isStanding,
        isCheapest: standing !== null && value === cheapest,
        standing,
      }),
    );
  }

  return `<div class="ladder-scroll"><div class="ladder">${rungs.join("")}</div></div>`;
}

function renderPlay(view: StateView): string {
  const game = view.state;
  const moves = legalMoves(game, view.you);
  const you = playerById(game, view.you);
  const standing = game.lastAnnouncement;
  const turnPlayer = playerById(game, game.turnPlayerId ?? "");
  const countdown = clock.secondsLeft(view.deadlineAt);
  const reveal = game.pendingDoubt ?? game.lastReveal;
  const turnIsMine = game.turnPlayerId !== null && game.turnPlayerId === view.you;

  let actions = "";
  if (game.phase === "finished") {
    const winner = game.gameOver?.winnerName ?? "somebody";
    actions = `<div class="card actions"><p class="winner">🏆 ${escapeHtml(winner)} wins</p>
      <div class="row gap">
        <a class="primary link" href="/">Back to the lobby</a>
        <button class="ghost" data-action="share">Share join link</button>
      </div>
      <p class="muted small">A table is single-use — start a new one to play again.</p></div>`;
  } else if (game.phase === "revealing") {
    actions = `<div class="card actions"><p class="muted">Reveal…</p></div>`;
  } else if (game.phase === "roundStart") {
    actions = `<div class="card actions"><p class="muted">Round ${game.round} — ${escapeHtml(
      turnPlayer?.name ?? "someone",
    )} is picking up the cup…</p></div>`;
  } else if (!turnIsMine) {
    actions = `<div class="card actions"><p class="muted">Waiting for ${escapeHtml(
      turnPlayer?.name ?? "the next player",
    )}${countdown !== null ? ` · <span data-countdown>${countdown}s</span>` : ""}</p></div>`;
  } else if (game.phase === "announcing") {
    const held = you?.dice ? rollValue(you.dice[0], you.dice[1]) : null;
    const heldBelowCut = held !== null && !moves.announcements.includes(held);
    actions = `<div class="card actions actions-tall">
      <p class="prompt">Your dice are secret. Claim something <b>higher than ${
        standing ? valueLabel(standing.value) : "anything"
      }</b>:</p>
      ${renderAnnounceLadder(moves.announcements, you?.dice ?? null, standing)}
      ${
        heldBelowCut
          ? `<p class="muted small">Your ${valueLabel(held)} sits below the cut — claim one of the lit rungs above it.</p>`
          : ""
      }
    </div>`;
  } else {
    actions = `<div class="card actions">
      <p class="prompt">${
        standing
          ? `Standing: <b>${valueLabel(standing.value)}</b> from ${escapeHtml(standing.playerName)}`
          : "You open the round."
      }</p>
      <div class="row gap">
        ${moves.canBelieve ? '<button class="primary" data-action="believe">Believe &amp; roll</button>' : ""}
        ${moves.canDoubt ? '<button class="danger" data-action="doubt">Doubt</button>' : ""}
        ${!moves.canBelieve && moves.canRoll ? '<button class="primary" data-action="roll">Roll the dice</button>' : ""}
      </div>
      ${
        !moves.canBelieve && moves.canRoll
          ? '<p class="muted small">Nobody has claimed anything yet, so you have to roll first.</p>'
          : ""
      }
    </div>`;
  }

  // The standing claim lives in the middle of the felt inside `renderPlayers`.
  // On the reveal beat the showdown takes over the screen as a fixed overlay, so
  // it never enters the page flow and cannot push the seats into the controls.
  // The game-ending doubt resolves to `finished` inside `resolveDoubt` (its
  // `resolveEliminations` runs before the reveal window can be used), so it has
  // no `revealing` phase to stage over; that one reveal falls back to a compact
  // card below the winner. A doubt that eliminates a player while others remain
  // alive stays in `revealing` and plays the full showdown.
  const rosterCard = renderPlayers(game, view);
  const showdown = reveal && game.phase === "revealing" ? renderShowdown(game, view, reveal) : "";
  const revealCard = reveal && game.phase !== "revealing" ? renderRevealCard(reveal) : "";
  return `
    ${rosterCard}
    ${revealCard}
    ${actions}${showdown}
    <section class="card log-card">
      <h3>Table talk</h3>
      <ol class="log">
        ${game.events
          .slice(-8)
          .reverse()
          .map((event) => `<li class="ev-${event.kind}">${escapeHtml(event.text)}</li>`)
          .join("")}
      </ol>
    </section>
    <div class="row gap">
      <button class="ghost" data-action="share">Share join link</button>
      <a class="ghost link" href="/">Leave table</a>
    </div>`;
}

// The ladder box is capped to the stylesheet's `30rem` (at a 16px root).
const LADDER_CAP = 480;

/**
 * The ladder scrolls inside its own box; start it with the cut line just under
 * the fold so the cheapest legal claim is the first rung under the thumb.
 *
 * The box is sized against the viewport rather than a flat `vh`: a `58vh` box
 * starts part-way down a phone page, so its bottom edge lands below the fold
 * and the pinned cut sits off-screen. Sizing it to the space left below its own
 * top puts that edge on the fold, so the reader never has to scroll the *page*
 * to reach the cut — only the ladder.
 *
 * The height is clamped to what is actually available, with no floor: a floor
 * larger than the free space is exactly what pushed the box back past the fold
 * at a full eight-seat table. The round table is a roughly fixed height whatever
 * the seat count, so the free space no longer grows with a shorter roster and
 * the ladder can stay below the table in every phase.
 *
 * The measurement is anchored to the document, so a reader who page-scrolls
 * down does not make the box grow on the next snapshot and drag the page with
 * it.
 */
function pinLadder(): void {
  const scroller = document.querySelector<HTMLElement>(".ladder-scroll");
  if (!scroller) return;

  // Distance from the box's top to the fold in document coordinates.
  const boxTop = scroller.getBoundingClientRect().top + window.scrollY;
  const available = window.innerHeight - boxTop;
  scroller.style.maxHeight = `${Math.max(0, Math.min(available, LADDER_CAP))}px`;

  const belowCut = scroller.querySelector<HTMLElement>(".announce[disabled]");
  if (belowCut) {
    // The first illegal rung is the standing claim; put its top at the box's
    // bottom edge so the cheapest legal claim is the last rung fully in view
    // above it — and, because the edge is on the fold, on screen.
    const box = scroller.getBoundingClientRect();
    scroller.scrollTop += belowCut.getBoundingClientRect().top - box.bottom;
  } else {
    // A round opener may claim anything, so there is no cut to pin. Open on the
    // head of the ranking — Mia, the doubles — rather than the cheapest rungs at
    // the foot, which teach nothing about the order.
    scroller.scrollTop = 0;
  }
}

/**
 * Replace the page but keep the reader where they were. Every snapshot rebuilds
 * the DOM, and without this a full-page replacement silently scrolls a phone
 * back to the top mid-game.
 */
function paint(html: string): void {
  const scrollY = window.scrollY;
  app.innerHTML = html;
  window.scrollTo(0, scrollY);
  pinLadder();
}

function render(): void {
  const view = state.view;
  const title = state.table?.name ?? view?.state.tableName ?? "Table";
  const topbar = `<header class="topbar"><a class="brand" href="/">Mia</a><span class="table-title">${escapeHtml(
    title,
  )}</span></header>`;

  // A terminal refusal (a full table) outranks everything: there is no snapshot
  // coming, so "Connecting…" would be a lie the page told forever.
  if (state.fatal !== null) {
    paint(`${topbar}
      <main class="page"><section class="card">
        <h2>Can’t join this table</h2>
        <p class="muted">${escapeHtml(state.fatal)}</p>
        <a class="primary link" href="/">Back to the lobby</a>
      </section></main>`);
    return;
  }

  if (!view) {
    // The error is rendered here too, not only beside a snapshot: an error that
    // arrives before the first snapshot is otherwise invisible until it is
    // cleared by the toast timer, which is exactly the stuck page this fixes.
    paint(`${topbar}
      <main class="page">
        ${state.error ? `<p class="toast">${escapeHtml(state.error)}</p>` : ""}
        <section class="card"><p class="muted">Connecting…</p></section>
      </main>`);
    return;
  }

  const started = view.state.round > 0;
  paint(`
    <header class="topbar">
      <a class="brand" href="/">Mia</a>
      <span class="table-title">${escapeHtml(title)}</span>
      <span class="round">${started ? `Round ${view.state.round}` : "Lobby"}</span>
    </header>
    <main class="page">
      ${state.error ? `<p class="toast">${escapeHtml(state.error)}</p>` : ""}
      ${started ? renderPlay(view) : renderWaiting(view)}
    </main>`);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

app.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;
  switch (target.dataset.action) {
    case "start":
      send({ type: "start" });
      break;
    case "roll":
      send({ type: "roll" });
      break;
    case "believe":
      send({ type: "believe" });
      break;
    case "doubt":
      send({ type: "doubt" });
      break;
    case "announce": {
      const value = Number(target.dataset.value);
      if (Number.isInteger(value)) send({ type: "announce", value });
      break;
    }
    case "share":
      void share();
      break;
    default:
      break;
  }
});

async function boot(): Promise<void> {
  if (!tableId) {
    location.replace("/");
    return;
  }
  try {
    state.table = await api.table(tableId);
  } catch (error) {
    app.innerHTML = `
      <header class="topbar"><a class="brand" href="/">Mia</a></header>
      <main class="page"><section class="card">
        <h2>Table not found</h2>
        <p class="muted">${escapeHtml(error instanceof Error ? error.message : "Unknown table.")}</p>
        <a class="primary link" href="/">Back to the lobby</a>
      </section></main>`;
    return;
  }
  document.title = `${state.table.name} — Mia`;
  socket = new TableSocket(tableId, {
    onState: (view) => {
      clock.sync(view.serverTime);
      state.view = view;
      render();
    },
    onError: (message, code) => {
      // "Table full" is terminal: there is no seat and no snapshot to wait for.
      // Stop the socket so the reconnect loop cannot spin, and show the reason
      // as a page rather than a toast that fades and leaves "Connecting…".
      if (code === "table-full") {
        state.fatal = message;
        socket?.close();
        render();
        return;
      }
      toast(message);
    },
    onClose: () => render(),
  });
  socket.connect();
  render();
}

// Tick the clock without redrawing the world. A full `render()` here would
// replace every node once a second, discarding text selection, in-flight taps,
// focus and CSS transitions on a phone — all for one changing number.
window.setInterval(() => {
  const view = state.view;
  if (!view || view.deadlineAt === null) return;
  const remaining = clock.secondsLeft(view.deadlineAt);
  if (remaining === state.lastCountdown) return;
  state.lastCountdown = remaining;
  const text = `${remaining}s`;
  for (const node of document.querySelectorAll<HTMLElement>("[data-countdown]")) {
    node.textContent = text;
  }
}, 500);

window.addEventListener("beforeunload", () => socket?.close());

void boot();
