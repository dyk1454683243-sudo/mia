/**
 * Lobby: identity, the open-tables list, table creation, and recent results.
 * Polls the JSON API; no WebSocket lives here.
 */
import type { HistoryEntry, TableSummary } from "../../src/shared/protocol";
import { api, escapeHtml, relativeTime } from "./net";

const POLL_MS = 4_000;

interface LobbyState {
  meId: string;
  meName: string;
  tables: TableSummary[];
  history: HistoryEntry[];
  historyOpen: boolean;
  error: string | null;
  loaded: boolean;
}

const app = document.querySelector<HTMLElement>("#app")!;
const state: LobbyState = {
  meId: "",
  meName: "",
  tables: [],
  history: [],
  historyOpen: false,
  error: null,
  loaded: false,
};

let editingName = false;
let rerolling = false;
let pollTimer: number | null = null;
const REROLL_MS = 400;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function rerollDiceHtml(): string {
  return `<span class="dice reroll-dice" aria-hidden="true"><span class="die sm hidden">?</span><span class="die sm hidden">?</span></span>`;
}

function toast(message: string): void {
  state.error = message;
  render();
  window.setTimeout(() => {
    if (state.error === message) {
      state.error = null;
      render();
    }
  }, 4_000);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderMe(): string {
  if (editingName) {
    return `<section class="card me-card">
      <label class="label" for="name-input">Your name</label>
      <form class="row gap" data-form="rename">
        <input id="name-input" name="name" maxlength="40" value="${escapeHtml(state.meName)}" autocomplete="off" />
        <button class="primary" type="submit">Save</button>
        <button class="ghost" type="button" data-action="cancel-rename">Cancel</button>
      </form>
      <p class="muted small">1–40 characters. Control characters are stripped.</p>
    </section>`;
  }
  return `<section class="card me-card">
    <p class="label">You are</p>
    <button class="name-button" data-action="edit-name" title="Tap to rename">
      <span class="name">${rerolling ? rerollDiceHtml() : escapeHtml(state.meName || "…")}</span>
      <span class="edit-hint">rename</span>
    </button>
    <button class="ghost reroll-btn" data-action="reroll-name"${rerolling ? " disabled" : ""}>Reroll name</button>
  </section>`;
}

function renderTables(): string {
  if (!state.loaded) return `<section class="card"><p class="muted">Loading tables…</p></section>`;
  if (state.tables.length === 0) {
    return `<section class="card"><h2>Open tables</h2><p class="muted">No tables waiting. Start one below.</p></section>`;
  }
  return `<section class="card">
    <h2>Open tables</h2>
    <ul class="tables">
      ${state.tables
        .map((table) => {
          const inGame = table.status === "playing";
          const full = table.playerCount >= table.maxPlayers;
          // A full waiting table has no seat left, so its label must not be a
          // live join link: "Full" used to navigate straight into a page that
          // could only ever say "Connecting…".
          const action = inGame
            ? `<a class="primary link" href="/t/${encodeURIComponent(table.id)}">Watch</a>`
            : full
              ? `<button class="primary" type="button" disabled>Full</button>`
              : `<a class="primary link" href="/t/${encodeURIComponent(table.id)}">Join</a>`;
          return `<li class="table-row">
            <div class="table-meta">
              <span class="name">${escapeHtml(table.name)}</span>
              <span class="muted small">${table.playerCount}/${table.maxPlayers} players · ${
                inGame ? "in progress" : `waiting · opened ${relativeTime(table.createdAt)}`
              }</span>
            </div>
            ${action}
          </li>`;
        })
        .join("")}
    </ul>
  </section>`;
}

function renderHistory(): string {
  if (state.history.length === 0) return "";
  return `<section class="card collapsible">
    <button class="collapse-head" data-action="toggle-history">
      <h2>Recent results</h2><span class="chev">${state.historyOpen ? "▾" : "▸"}</span>
    </button>
    ${
      state.historyOpen
        ? `<ul class="history">${state.history
            .map(
              (game) => `<li>
                <div class="table-meta">
                  <span class="name">${escapeHtml(game.winnerName)} won at ${escapeHtml(game.tableName)}</span>
                  <span class="muted small">${relativeTime(game.finishedAt)} · ${game.players.length} players</span>
                </div>
                <ol class="places">${game.players
                  .map(
                    (player) =>
                      `<li><span class="place">${player.place}</span> ${escapeHtml(player.name)} <span class="muted small">${
                        player.livesLeft
                      } lives · ${player.roundsPlayed} rounds</span></li>`,
                  )
                  .join("")}</ol>
              </li>`,
            )
            .join("")}</ul>`
        : ""
    }
  </section>`;
}

/** Replace the page but keep the reader where they were across a poll. */
function paint(html: string): void {
  const scrollY = window.scrollY;
  app.innerHTML = html;
  window.scrollTo(0, scrollY);
}

function render(): void {
  paint(`
    <header class="topbar"><span class="brand">Mia</span><span class="round">dice bluffing</span></header>
    <main class="page">
      ${state.error ? `<p class="toast">${escapeHtml(state.error)}</p>` : ""}
      ${renderMe()}
      ${renderTables()}
      <section class="card">
        <h2>New table</h2>
        <form class="row gap" data-form="create">
          <input name="name" maxlength="40" placeholder="Table name" autocomplete="off" />
          <button class="primary" type="submit">Create</button>
        </form>
        <p class="muted small">You get a shareable link to send to friends.</p>
      </section>
      ${renderHistory()}
      <p class="muted small footer">Mia · highest die first, doubles beat mixed, 21 is unbeatable.</p>
    </main>`);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function refresh(): Promise<void> {
  try {
    const [tables, history] = await Promise.all([api.tables(), api.history()]);
    state.tables = tables;
    state.history = history;
    state.loaded = true;
    state.error = null;
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Could not reach the server.";
  }
  render();
}

async function rerollName(): Promise<void> {
  if (rerolling || editingName) return;
  const reduce = prefersReducedMotion();
  const started = performance.now();
  if (!reduce) {
    rerolling = true;
    render();
  }
  try {
    const me = await api.reroll();
    state.meName = me.name;
  } catch (error) {
    toast(error instanceof Error ? error.message : "Could not reroll that name.");
  }
  const wait = reduce ? 0 : Math.max(0, REROLL_MS - (performance.now() - started));
  window.setTimeout(() => {
    rerolling = false;
    render();
  }, wait);
}

async function saveName(name: string): Promise<void> {
  try {
    const me = await api.rename(name);
    state.meName = me.name;
    editingName = false;
    render();
  } catch (error) {
    toast(error instanceof Error ? error.message : "Could not save that name.");
  }
}

async function createTable(name: string): Promise<void> {
  try {
    const table = await api.createTable(name);
    location.href = `/t/${encodeURIComponent(table.id)}`;
  } catch (error) {
    toast(error instanceof Error ? error.message : "Could not create that table.");
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

app.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;
  switch (target.dataset.action) {
    case "edit-name":
      editingName = true;
      render();
      app.querySelector<HTMLInputElement>("#name-input")?.select();
      break;
    case "cancel-rename":
      editingName = false;
      render();
      break;
    case "reroll-name":
      void rerollName();
      break;
    case "toggle-history":
      state.historyOpen = !state.historyOpen;
      render();
      break;
    default:
      break;
  }
});

app.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const data = new FormData(form);
  const value = String(data.get("name") ?? "");
  if (form.dataset.form === "rename") void saveName(value);
  else if (form.dataset.form === "create") void createTable(value);
});

async function boot(): Promise<void> {
  try {
    const me = await api.me();
    state.meId = me.id;
    state.meName = me.name;
  } catch (error) {
    toast(error instanceof Error ? error.message : "Could not identify you.");
  }
  await refresh();
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    if (!editingName && !rerolling) void refresh();
  }, POLL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});

void boot();
