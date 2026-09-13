/**
 * Table page: one render function over the latest server snapshot.
 * All hidden-dice redaction happens server-side; this file only draws.
 */
import {
  formatValue,
  isDouble,
  legalMoves,
  MIA,
  playerById,
  STARTING_LIVES,
  type MiaPlayer,
  type MiaState,
} from "../../src/shared/mia";
import type { ClientMessage, StateView, TableSummary } from "../../src/shared/protocol";
import { TurnClock } from "../../src/shared/clock";
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

function verdictLine(reveal: { verdict: string; announcerName: string; doubterName: string; actual: number; announced: number; livesLost: number; penaltyApplied: string }): string {
  const penalty = reveal.penaltyApplied === "double-mia" ? " Doubled — the Mia was real." : "";
  const lives = `${reveal.livesLost} ${reveal.livesLost === 1 ? "life" : "lives"}`;
  if (reveal.verdict === "announcer") {
    return `<p class="verdict caught">${escapeHtml(reveal.announcerName)} had <b>${formatValue(
      reveal.actual,
    )}</b> but claimed <b>${formatValue(reveal.announced)}</b>. Bluff caught — loses ${lives}.${penalty}</p>`;
  }
  return `<p class="verdict believed">${escapeHtml(reveal.announcerName)} really had <b>${formatValue(
    reveal.actual,
  )}</b>, claimed <b>${formatValue(reveal.announced)}</b>. ${escapeHtml(reveal.doubterName)} doubted — loses ${lives}.${penalty}</p>`;
}

interface PageState {
  table: TableSummary | null;
  view: StateView | null;
  error: string | null;
  lastCountdown: number | null;
}

const app = document.querySelector<HTMLElement>("#app")!;
const tableId = location.pathname.startsWith("/t/") ? decodeURIComponent(location.pathname.slice(3)) : "";
const state: PageState = { table: null, view: null, error: null, lastCountdown: null };
/** Drift is captured when a snapshot lands, then reused for every tick. */
const clock = new TurnClock();
let socket: TableSocket | null = null;

function send(message: ClientMessage): void {
  socket?.send(message);
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
  const isHost = players.length > 0 && players[0]!.id === view.you;
  const enough = players.length >= 2;
  const rows = players
    .map(
      (player, index) => `<li class="roster-row">
        <span class="seat">${index + 1}</span>
        <span class="name">${escapeHtml(player.name)}${player.id === view.you ? " <em>(you)</em>" : ""}</span>
        ${index === 0 ? '<span class="badge">opened</span>' : ""}
        ${view.connected.includes(player.id) ? "" : '<span class="badge muted">offline</span>'}
      </li>`,
    )
    .join("");

  return `
    <section class="card room-card">
      <h2>${escapeHtml(state.table?.name ?? view.state.tableName)}</h2>
      <p class="muted">${players.length} of 8 seats taken · ${STARTING_LIVES} lives each</p>
      <ul class="roster">${rows}</ul>
      ${
        isHost
          ? `<button class="primary big" data-action="start" ${enough ? "" : "disabled"}>
               ${enough ? "Start the game" : "Waiting for at least 2 players…"}
             </button>`
          : `<p class="waiting-line">Waiting for the table opener to start…</p>`
      }
      <div class="row gap">
        <button class="ghost" data-action="share">Share join link</button>
        <a class="ghost link" href="/">Back to lobby</a>
      </div>
    </section>`;
}

function renderPlayers(game: MiaState, view: StateView): string {
  return `<ul class="players">${game.players
    .map((player) => {
      const turn = game.turnPlayerId === player.id;
      const cup = game.diceOwnerId === player.id && game.phase !== "finished";
      const offline = !view.connected.includes(player.id);
      const lives = Array.from({ length: STARTING_LIVES }, (_, index) =>
        index < player.lives ? '<i class="pip on"></i>' : '<i class="pip"></i>',
      ).join("");
      return `<li class="player ${turn ? "turn" : ""} ${player.eliminated ? "out" : ""}">
        <div class="player-head">
          <span class="name">${escapeHtml(player.name)}${player.id === view.you ? " <em>(you)</em>" : ""}</span>
          <span class="tag-row">
            ${player.eliminated ? '<span class="badge out">out</span>' : ""}
            ${cup ? '<span class="badge cup">cup</span>' : ""}
            ${turn ? '<span class="badge turn">their turn</span>' : ""}
            ${offline && !player.eliminated ? '<span class="badge muted">offline</span>' : ""}
          </span>
        </div>
        <div class="pips" aria-label="${player.lives} of ${STARTING_LIVES} lives">${lives}</div>
        ${player.dice ? `<div class="player-dice">${diceOf(player, "sm")}</div>` : ""}
      </li>`;
    })
    .join("")}</ul>`;
}

function renderAnnounceGrid(announcements: number[], myDice: [number, number] | null): string {
  const mineValue = myDice ? myDice[0] * 10 + myDice[1] : null;
  return `<div class="announce-grid">${announcements
    .map(
      (value) => `<button class="announce ${value === MIA ? "mia" : ""} ${
        value === mineValue ? "mine" : ""
      }" data-action="announce" data-value="${value}">
        ${value === MIA ? "MIA" : formatValue(value)}
        ${value === mineValue ? "<small>yours</small>" : ""}
      </button>`,
    )
    .join("")}</div>`;
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
      </div></div>`;
  } else if (game.phase === "revealing") {
    actions = `<div class="card actions"><p class="muted">Reveal…</p></div>`;
  } else if (game.phase === "roundStart") {
    actions = `<div class="card actions"><p class="muted">Round ${game.round} — ${escapeHtml(
      turnPlayer?.name ?? "someone",
    )} is picking up the cup…</p></div>`;
  } else if (!turnIsMine) {
    actions = `<div class="card actions"><p class="muted">Waiting for ${escapeHtml(
      turnPlayer?.name ?? "the next player",
    )}${countdown !== null ? ` · ${countdown}s` : ""}</p></div>`;
  } else if (game.phase === "announcing") {
    actions = `<div class="card actions">
      <p class="prompt">Your dice are secret. Claim something <b>higher than ${
        standing ? formatValue(standing.value) : "anything"
      }</b>:</p>
      ${renderAnnounceGrid(moves.announcements, you?.dice ?? null)}
      ${
        moves.announcements.length === 0
          ? '<p class="muted small">Nothing outranks what is standing — you have to announce anyway and hope.</p>'
          : ""
      }
    </div>`;
  } else {
    actions = `<div class="card actions">
      <p class="prompt">${
        standing
          ? `Standing: <b>${formatValue(standing.value)}</b> from ${escapeHtml(standing.playerName)}`
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

  return `
    <section class="card standing-card">
      <p class="label">Standing announcement</p>
      <div class="standing">${standing ? valueChip(standing.value) : '<span class="muted">nothing yet</span>'}</div>
      ${
        standing
          ? `<p class="muted">claimed by ${escapeHtml(standing.playerName)}</p>`
          : ""
      }
      ${
        reveal
          ? `<div class="reveal">
              <div class="reveal-dice">
                <div><p class="label">claimed</p>${valueChip(reveal.announced)}</div>
                <div><p class="label">actual</p>${valueChip(reveal.actual, "actual")}</div>
              </div>
              ${verdictLine(reveal)}
            </div>`
          : ""
      }
    </section>
    <section class="card">${renderPlayers(game, view)}</section>
    ${actions}
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

function render(): void {
  const view = state.view;
  const title = state.table?.name ?? view?.state.tableName ?? "Table";
  if (!view) {
    app.innerHTML = `
      <header class="topbar"><a class="brand" href="/">Mia</a><span class="table-title">${escapeHtml(title)}</span></header>
      <main class="page"><section class="card"><p class="muted">Connecting…</p></section></main>`;
    return;
  }

  const started = view.state.round > 0;
  app.innerHTML = `
    <header class="topbar">
      <a class="brand" href="/">Mia</a>
      <span class="table-title">${escapeHtml(title)}</span>
      <span class="round">${started ? `Round ${view.state.round}` : "Lobby"}</span>
    </header>
    <main class="page">
      ${state.error ? `<p class="toast">${escapeHtml(state.error)}</p>` : ""}
      ${started ? renderPlay(view) : renderWaiting(view)}
    </main>`;
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
    onError: (message) => toast(message),
    onClose: () => render(),
  });
  socket.connect();
  render();
}

// Keep the countdown honest without redrawing the world every frame.
window.setInterval(() => {
  const view = state.view;
  if (!view || view.deadlineAt === null) return;
  const remaining = clock.secondsLeft(view.deadlineAt);
  if (remaining !== state.lastCountdown) {
    state.lastCountdown = remaining;
    render();
  }
}, 500);

window.addEventListener("beforeunload", () => socket?.close());

void boot();
