/**
 * R1 browser verification: drives the real client in Chromium at a phone
 * viewport, plays a full game against `scripts/bots.ts`, captures screenshots,
 * and reports console errors.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=$PWD/.playwright-browsers node scripts/ui-check.ts
 *
 * Requires `wrangler dev` on http://127.0.0.1:8787 (override with MIA_BASE).
 * Screenshots land in `.r1-screenshots/` (gitignored).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { formatValue, MAX_PLAYERS, MIA, MIN_PLAYERS, outranks, RANKING } from "../src/shared/mia.ts";
import { api, BASE, createPlayer } from "./lib.ts";

const OUT = process.env.MIA_UI_OUT ?? ".r1-screenshots";
const PHONE = { width: 375, height: 812 };
const WIDE = { width: 768, height: 1024 };
/**
 * A viewport above the desktop breakpoint. `WIDE` (768) is deliberately below
 * it, so it never exercised the three-column layout — the "fixture never
 * reaches the regime" trap from docs/testing.md. This one does.
 */
const DESKTOP = { width: 1280, height: 800 };
mkdirSync(OUT, { recursive: true });

/**
 * How many seats the main game fills. It defaults to a **full** table on
 * purpose: the ladder's top is pushed down by the roster above it, so the
 * pinned-cut geometry is worst at `MAX_PLAYERS` and a three-seat table can pass
 * while a full one fails. Override for a smaller table, e.g.
 * `MIA_UI_SEATS=3 npm run ui-check`.
 */
const SEATS = Number(process.env.MIA_UI_SEATS ?? String(MAX_PLAYERS));
if (!Number.isInteger(SEATS) || SEATS < MIN_PLAYERS || SEATS > MAX_PLAYERS) {
  throw new Error(`MIA_UI_SEATS must be an integer ${MIN_PLAYERS}-${MAX_PLAYERS}, got "${process.env.MIA_UI_SEATS}"`);
}
/** The browser holds one seat; bots take the rest. */
const BOTS = SEATS - 1;

interface Step {
  name: string;
  ok: boolean;
  detail: string;
}
const steps: Step[] = [];
const notes: string[] = [];
const consoleErrors: string[] = [];
const pageErrors: string[] = [];

function check(name: string, ok: boolean, detail = ""): boolean {
  steps.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}
function note(message: string): void {
  notes.push(message);
  console.log(`  [note] ${message}`);
}
function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The legal announce set for a standing claim, from the engine's own table.
 * Ranking-aware on purpose: `65` standing permits `11`, and `11 > 65` is false.
 */
function legalClaims(standing: number | null): number[] {
  return standing === null ? [...RANKING] : RANKING.filter((value) => outranks(value, standing));
}

/** Compare two value sets order-independently. */
function sameNumberSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const expected = new Set(b);
  return a.every((value) => expected.has(value));
}

/** Mia reads "MIA", not "2·1". */
function labelValue(value: number): string {
  return value === MIA ? "MIA" : formatValue(value);
}

/** The inverse of `labelValue`, for reading a claim back off the DOM. */
function claimRank(label: string): number {
  return label === "MIA" ? MIA : Number(label.replace("·", ""));
}

function watch(page: Page): void {
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${page.url()} :: ${message.text()}`);
  });
  page.on("pageerror", (error) => pageErrors.push(`${page.url()} :: ${error.message}`));
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  [shot] ${OUT}/${name}.png`);
}

async function overflow(page: Page): Promise<number> {
  return await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
}

interface DesktopColumns {
  /** Controls, felt and log sit left-to-right with no horizontal overlap. */
  sideBySide: boolean;
  /** Sum of pairwise horizontal overlap, so two bands sharing width fails. */
  overlap: number;
  widths: number[];
  detail: string;
}

/**
 * The desktop layout's promise: above the breakpoint the controls (`.actions`),
 * the felt (`.table-card`) and the log (`.log-card`) occupy three distinct,
 * non-overlapping horizontal bands, left to right. Below the breakpoint they
 * stack in one column and their x-ranges coincide, which is exactly what makes
 * this fail if the media query is removed.
 */
async function desktopColumns(page: Page): Promise<DesktopColumns> {
  return await page.evaluate(() => {
    const box = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect() ?? null;
    const actions = box(".actions");
    const felt = box(".table-card");
    const log = box(".log-card");
    if (!actions || !felt || !log) {
      return { sideBySide: false, overlap: -1, widths: [], detail: "missing actions/felt/log" };
    }
    const rects = [actions, felt, log];
    let overlap = 0;
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const shared = Math.min(rects[i]!.right, rects[j]!.right) - Math.max(rects[i]!.left, rects[j]!.left);
        overlap += Math.max(0, Math.round(shared));
      }
    }
    return {
      sideBySide: actions.right <= felt.left + 1 && felt.right <= log.left + 1,
      overlap,
      widths: rects.map((rect) => Math.round(rect.width)),
      detail: `actions ${Math.round(actions.left)}-${Math.round(actions.right)} · felt ${Math.round(
        felt.left,
      )}-${Math.round(felt.right)} · log ${Math.round(log.left)}-${Math.round(log.right)}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

async function verifyLobby(page: Page): Promise<void> {
  section("Lobby at 375x812");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".me-card .name");
  const shipName = (await page.textContent(".me-card .name"))?.trim() ?? "";
  check("a ship name is shown", shipName.length > 3, shipName);
  await shot(page, "01-lobby");
  check("no horizontal scroll at 375px", (await overflow(page)) === 0, `${await overflow(page)}px overflow`);

  // Rename, and prove it survives a reload.
  await page.click('[data-action="edit-name"]');
  await page.waitForSelector("#name-input");
  await page.fill("#name-input", "Browser Player");
  await page.click('form[data-form="rename"] button[type="submit"]');
  await page.waitForFunction(() => document.querySelector(".me-card .name")?.textContent?.trim() === "Browser Player");
  check("inline rename saves", true);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".me-card .name");
  check("rename persists across a reload", (await page.textContent(".me-card .name"))?.trim() === "Browser Player");

  // The 4s poll must not disturb an open rename field.
  await page.click('[data-action="edit-name"]');
  await page.focus("#name-input");
  await page.fill("#name-input", "Typing…");
  await page.evaluate(() => window.scrollTo(0, 260));
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await sleep(5_200); // longer than POLL_MS
  const focusKept = await page.evaluate(() => document.activeElement?.id === "name-input");
  const scrollAfter = await page.evaluate(() => window.scrollY);
  const valueKept = await page.inputValue("#name-input");
  check("the poll leaves the rename field focused", focusKept);
  check("the poll does not jump the scroll position", Math.abs(scrollAfter - scrollBefore) <= 1, `${scrollBefore} -> ${scrollAfter}`);
  check("the poll does not clobber typed text", valueKept === "Typing…", valueKept);
  await page.click('[data-action="cancel-rename"]');

  // A poll refresh must not throw the reader back to the top of the page.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const scrolled = await page.evaluate(() => window.scrollY);
  await sleep(5_000); // longer than POLL_MS, so a refresh lands
  const afterPoll = await page.evaluate(() => window.scrollY);
  check("a poll refresh keeps the reader's scroll position", Math.abs(afterPoll - scrolled) <= 1, `${scrolled} -> ${afterPoll}`);

  // A table created elsewhere shows up in the list.
  const seeder = await createPlayer("lobby-seed");
  const seeded = await api("/api/tables", {
    method: "POST",
    player: seeder,
    body: JSON.stringify({ name: "Listed table" }),
  });
  check("setup: a second table exists", seeded.status === 201, `status ${seeded.status}`);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".tables .name").length > 0);
  const listText = (await page.textContent(".tables")) ?? "";
  check("the lobby lists open tables", listText.includes("Listed table"), listText.replace(/\s+/g, " ").slice(0, 80));
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

async function createTableThroughUi(page: Page): Promise<string> {
  section("Create a table through the UI");
  await page.reload({ waitUntil: "networkidle" });
  await page.fill('form[data-form="create"] input[name="name"]', "R1 table");
  await page.click('form[data-form="create"] button[type="submit"]');
  await page.waitForURL(/\/t\//, { timeout: 10_000 });
  const tableId = new URL(page.url()).pathname.slice(3);
  check("creating a named table opens it", tableId.length > 0, page.url());
  return tableId;
}

async function verifyShare(page: Page, context: BrowserContext, browser: Browser, tableId: string): Promise<void> {
  section("Share link");
  await page.waitForSelector(".room-card");

  // The Web Share API path: stub it and inspect what the page hands over.
  await page.evaluate(() => {
    (window as unknown as { __shared: { url?: string }[] }).__shared = [];
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: { url?: string }) => {
        (window as unknown as { __shared: { url?: string }[] }).__shared.push(data);
      },
    });
  });
  await page.click('[data-action="share"]');
  const sharedUrl = await page.evaluate(
    () => (window as unknown as { __shared: { url?: string }[] }).__shared[0]?.url ?? "",
  );
  check("navigator.share receives the /t/:id link", sharedUrl.endsWith(`/t/${tableId}`), sharedUrl);

  // The clipboard fallback, with its toast.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  await page.evaluate(() => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  });
  await page.click('[data-action="share"]');
  await page.waitForSelector(".toast", { timeout: 5_000 });
  const toast = (await page.textContent(".toast"))?.trim() ?? "";
  const copied = await page.evaluate(async () => await navigator.clipboard.readText());
  check("clipboard fallback copies the /t/:id link", copied.endsWith(`/t/${tableId}`), copied);
  check("clipboard fallback shows a toast", toast === "Join link copied.", toast);

  // The copied link joins the table from a brand-new session. This runs before
  // the roster is filled, on purpose: a *full* table cannot take a fresh joiner
  // (a pre-existing bug, see `fix/full-table-join`), so the share step needs a
  // free seat and the bots arrive afterwards.
  const rosterBefore = await page.evaluate(() => document.querySelectorAll(".roster-row").length);
  const fresh = await browser.newContext({ viewport: PHONE });
  const freshPage = await fresh.newPage();
  watch(freshPage);
  await freshPage.goto(copied, { waitUntil: "networkidle" });
  await freshPage.waitForSelector(".room-card", { timeout: 10_000 });
  const heading = (await freshPage.textContent(".room-card h2"))?.trim();
  const seats = await freshPage.evaluate(() => document.querySelectorAll(".roster-row").length);
  check(
    "the shared link joins the table in a fresh session",
    heading === "R1 table" && seats === rosterBefore + 1,
    `${heading} · ${seats} seats (was ${rosterBefore})`,
  );
  await shot(freshPage, "03-fresh-session-join");
  await fresh.close();
  // B5: closing that session frees its pre-game seat again.
  await page.waitForFunction((expected) => document.querySelectorAll(".roster-row").length === expected, rosterBefore, { timeout: 15_000 });
  check("closing the fresh session frees its seat", true, `${rosterBefore} seats`);
}

/**
 * B12: the D1 creator owns the start button, whatever order the sockets arrive
 * in. A friend opens the link first, so the friend is the Durable Object's
 * seat 0; the creator must still be able to start.
 */
async function verifyCreatorCanStart(browser: Browser): Promise<void> {
  section("The creator can start a table a friend opened first (B12)");
  const creator = await createPlayer("creator");
  const friend = await createPlayer("friend");
  const created = await api("/api/tables", {
    method: "POST",
    player: creator,
    body: JSON.stringify({ name: "B12 table" }),
  });
  const tableId = (created.body as { id: string }).id;
  const url = `${BASE}/t/${tableId}`;
  const session = (player: { cookie: string }): { name: string; value: string; url: string } => ({
    name: "mia_pid",
    value: player.cookie.replace(/^mia_pid=/, ""),
    url: BASE,
  });

  const friendContext = await browser.newContext({ viewport: PHONE });
  await friendContext.addCookies([session(friend)]);
  const friendPage = await friendContext.newPage();
  watch(friendPage);
  await friendPage.goto(url, { waitUntil: "networkidle" });
  await friendPage.waitForSelector(".roster-row");

  const creatorContext = await browser.newContext({ viewport: PHONE });
  await creatorContext.addCookies([session(creator)]);
  const creatorPage = await creatorContext.newPage();
  watch(creatorPage);
  await creatorPage.goto(url, { waitUntil: "networkidle" });
  await creatorPage.waitForFunction(() => document.querySelectorAll(".roster-row").length === 2);
  await friendPage.waitForSelector(".waiting-line", { timeout: 10_000 });

  const roster = await creatorPage.$$eval(".roster-row .name", (nodes) =>
    nodes.map((node) => node.textContent?.trim() ?? ""),
  );
  check("the friend's socket is seat 0, so the race is real", roster[0]?.includes(friend.name) === true, JSON.stringify(roster));
  check("the creator still sees the start button", (await creatorPage.$('[data-action="start"]')) !== null);
  check("the friend is not offered the start button", (await friendPage.$('[data-action="start"]')) === null);
  const waiting = ((await friendPage.textContent(".waiting-line")) ?? "").trim();
  check("the waiting line names the creator", waiting.includes(creator.name), waiting);

  await creatorPage.click('[data-action="start"]');
  const started = await creatorPage
    .waitForSelector(".players, .winner", { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  check("the creator can start their own table", started);
  await shot(creatorPage, "12-creator-started");
  await friendContext.close();
  await creatorContext.close();
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------
interface Snapshot {
  phase: "roundStart" | "deciding" | "announcing" | "revealing" | "finished" | "unknown";
  round: number;
  actions: string;
  countdown: string | null;
  standing: string;
  standingValue: number | null;
  reveal: string;
  revealClaimed: string;
  verdict: string;
  /** The staged showdown: its presence, its stamp and the verdict's register. */
  showdown: boolean;
  stamp: string;
  verdictTone: "caught" | "believed" | "";
  /** The beat the showdown painted at, and the window it is staging over. */
  beat: number | null;
  showdownTone: "caught" | "believed" | "mia" | "";
  showdownElapsed: number | null;
  showdownSpan: number | null;
  winner: string;
  announce: {
    values: number[];
    mia: boolean;
    mine: boolean;
    tappable: number[];
    disabled: number[];
    hasCut: boolean;
    standingRung: number | null;
  };
  players: { name: string; you: boolean; dice: boolean; cup: boolean; out: boolean; turn: boolean; lives: number }[];
  /** How many `.player` seats the table drew — eliminated players included. */
  seatCount: number;
  /** The player id on the centre `.standing` chip, so the claim is tied to a seat. */
  standingClaimerId: string | null;
  /** The text claim bubble and the seat it hangs on. */
  claim: { by: string | null; count: number; value: string };
  /** The endgame replay: the last round's filmstrip and the lines under it. */
  film: {
    cells: number;
    claims: number;
    doubt: number;
    truth: number;
    claimValues: string[];
    truthValue: string;
    caption: string;
  };
  stats: { rows: number; you: boolean; lines: string[]; chips: string[] };
  rematch: { button: boolean; link: string | null };
  /** The honest-player stamp, if the winner never bluffed. Rare, and not required. */
  honestBadge: string;
  honestOnResultCard: boolean;
}

async function snapshot(page: Page): Promise<Snapshot> {
  return await page.evaluate((miaValue: number) => {
    const text = (selector: string) => document.querySelector(selector)?.textContent?.trim() ?? "";
    const enabled = (element: Element) => !element.hasAttribute("disabled");
    const buttons = [...document.querySelectorAll<HTMLElement>(".announce")];
    const values = buttons.map((button) => Number(button.dataset.value));
    const standingNode = document.querySelector<HTMLElement>(".standing");
    const standingText = standingNode?.textContent?.trim() ?? "";
    // `formatValue` renders Mia as "MIA", not "2·1". A digits-only parse would
    // read a Mia claim as null and compute the legal set backwards. This is read
    // from the page-level card, deliberately *not* from the ladder's own
    // `rung-standing`, so the "cut rung matches the standing claim" check below
    // still compares two independent sources.
    const standingValue =
      standingText === "nothing yet"
        ? null
        : /\bMIA\b/.test(standingText)
          ? miaValue
          : Number(standingText.replace(/\D/g, "")) || null;
    const standingButton = document.querySelector<HTMLElement>(".announce.rung-standing");
    const players = [...document.querySelectorAll<HTMLElement>(".player")].map((row) => ({
      name: row.querySelector(".name")?.textContent?.trim() ?? "",
      you: row.querySelector(".name em") !== null,
      dice: row.querySelector(".player-dice") !== null,
      cup: row.querySelector(".badge.cup") !== null,
      out: row.classList.contains("out"),
      turn: row.classList.contains("turn"),
      lives: row.querySelectorAll(".pip.on").length,
    }));
    const claimNodes = [...document.querySelectorAll<HTMLElement>(".player .claim")];
    const claim = {
      by: claimNodes[0]?.closest<HTMLElement>(".player")?.dataset.playerId ?? null,
      count: claimNodes.length,
      value: claimNodes[0]?.textContent?.trim() ?? "",
    };
    // The endgame. The filmstrip is read as a shape — how many cells, and how
    // many of each kind — plus the values themselves, so the strip's claims can
    // be checked against the claim on the felt and the truth against the caption.
    const filmCells = [...document.querySelectorAll<HTMLElement>(".film-cell")];
    const film = {
      cells: filmCells.length,
      claims: filmCells.filter((cell) => cell.classList.contains("claim")).length,
      doubt: filmCells.filter((cell) => cell.classList.contains("doubt")).length,
      truth: filmCells.filter((cell) => cell.classList.contains("truth")).length,
      claimValues: filmCells
        .filter((cell) => cell.classList.contains("claim"))
        .map((cell) => cell.querySelector(".film-value")?.textContent?.trim() ?? ""),
      truthValue: document.querySelector(".film-cell.truth .film-value")?.textContent?.trim() ?? "",
      caption: document.querySelector(".film-caption")?.textContent?.trim() ?? "",
    };
    const statRows = [...document.querySelectorAll<HTMLElement>(".stat-row")];
    const stats = {
      rows: statRows.length,
      you: statRows.some((row) => row.classList.contains("you")),
      lines: statRows.map((row) => row.querySelector(".stat-line")?.textContent?.trim() ?? ""),
      chips: [...document.querySelectorAll<HTMLElement>(".stat-chip")].map((chip) => chip.textContent?.trim() ?? ""),
    };
    const rematch = {
      button: document.querySelector('[data-action="rematch"]') !== null,
      link: document.querySelector<HTMLAnchorElement>('[data-action="join-rematch"]')?.getAttribute("href") ?? null,
    };
    const honestBadge = text(".honest-badge");
    const honestOnResultCard = document.querySelector(".actions-end .honest-badge") !== null;
    const actions = text(".actions");
    const verdictNode = document.querySelector<HTMLElement>(".verdict");
    const showdownNode = document.querySelector<HTMLElement>(".showdown");
    const showdownToneClass = showdownNode
      ? (["caught", "believed", "mia"] as const).find((tone) => showdownNode.classList.contains(tone)) ?? ""
      : "";
    let phase: Snapshot["phase"] = "unknown";
    if (text(".winner")) phase = "finished";
    else if (document.querySelector(".reveal")) phase = "revealing";
    else if (buttons.length > 0) phase = "announcing";
    else if (document.querySelector('[data-action="roll"], [data-action="believe"], [data-action="doubt"]')) phase = "deciding";
    else if (/picking up the cup|is picking up/.test(actions)) phase = "roundStart";
    return {
      phase,
      round: Number((text(".round").match(/\d+/) ?? ["0"])[0]),
      actions,
      countdown: document.querySelector("[data-countdown]")?.textContent?.trim() ?? null,
      standing: standingText,
      standingValue,
      reveal: text(".reveal"),
      revealClaimed: text(".reveal-dice"),
      verdict: text(".verdict"),
      showdown: showdownNode !== null,
      stamp: text(".showdown-stamp"),
      verdictTone: verdictNode?.classList.contains("caught")
        ? "caught"
        : verdictNode?.classList.contains("believed")
          ? "believed"
          : "",
      beat: showdownNode ? Number(showdownNode.className.match(/beat-(\d)/)?.[1] ?? "") || null : null,
      showdownTone: showdownToneClass,
      showdownElapsed: showdownNode
        ? Number.parseFloat(showdownNode.style.getPropertyValue("--showdown-elapsed")) || 0
        : null,
      showdownSpan: showdownNode
        ? Number.parseFloat(showdownNode.style.getPropertyValue("--showdown-span")) || 0
        : null,
      winner: text(".winner"),
      announce: {
        // Every rendered rung, then the subset carrying a real `disabled`.
        values,
        mia: document.querySelector(".announce.mia") !== null,
        mine: document.querySelector(".announce.mine") !== null,
        tappable: buttons.filter(enabled).map((button) => Number(button.dataset.value)),
        disabled: buttons.filter((button) => !enabled(button)).map((button) => Number(button.dataset.value)),
        hasCut: document.querySelector(".ladder-cut") !== null,
        standingRung: standingButton ? Number(standingButton.dataset.value) : null,
      },
      players,
      seatCount: players.length,
      standingClaimerId: standingNode?.dataset.claimerId ?? null,
      claim,
      film,
      stats,
      rematch,
      honestBadge,
      honestOnResultCard,
    } as Snapshot;
  }, MIA);
}

/**
 * Overlap in CSS pixels between the seats and the actions card.
 *
 * The union of the seat rects, not the `.players` container: that container is
 * now `position: absolute; inset: 0` over the felt, so its rect is the felt's
 * bounding box, while each seat is translated `-50%, -50%` and can hang past it.
 * Measuring the seats themselves is what the check meant when `.players` was an
 * in-flow list that tightly bounded its own content.
 *
 * The comparison is against the actions card's *border* box, so a seat that
 * touches the card at all fails. The card's `0.9rem` padding is not tolerance:
 * the `.table-card` keeps enough bottom padding that the ring's own chair clears
 * the card at the source. Fix the layout, not the measurement.
 */
async function playersActionsOverlap(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const seats = [...document.querySelectorAll<HTMLElement>(".player")].map((seat) => seat.getBoundingClientRect());
    const actionsNode = document.querySelector<HTMLElement>(".actions");
    if (seats.length === 0 || !actionsNode) return 0;
    const actions = actionsNode.getBoundingClientRect();
    const players = {
      top: Math.min(...seats.map((rect) => rect.top)),
      bottom: Math.max(...seats.map((rect) => rect.bottom)),
      left: Math.min(...seats.map((rect) => rect.left)),
      right: Math.max(...seats.map((rect) => rect.right)),
    };
    const vertical = Math.min(players.bottom, actions.bottom) - Math.max(players.top, actions.top);
    const horizontal = Math.min(players.right, actions.right) - Math.max(players.left, actions.left);
    return Math.max(0, Math.round(Math.min(vertical, horizontal)));
  });
}

/**
 * The seat geometry the round table promises: the viewer's chair is the
 * bottom-most on the ring, whatever the seat count. Measuring centre points
 * rather than tops keeps it about position, not how tall a name wrapped.
 */
async function seatLayout(page: Page): Promise<{ youIsBottom: boolean; detail: string }> {
  return await page.evaluate(() => {
    const seats = [...document.querySelectorAll<HTMLElement>(".player")];
    const you = seats.find((seat) => seat.querySelector(".name em")) ?? null;
    if (!you) return { youIsBottom: false, detail: "no viewer seat" };
    const centreY = (element: HTMLElement) => {
      const box = element.getBoundingClientRect();
      return box.top + box.height / 2;
    };
    const youY = centreY(you);
    const lowestOther = Math.max(...seats.filter((seat) => seat !== you).map(centreY));
    return {
      youIsBottom: youY >= lowestOther - 1,
      detail: `you ${Math.round(youY)} · next ${Math.round(lowestOther)} · ${seats.length} seats`,
    };
  });
}

interface LadderPin {
  scrollY: number;
  fold: number;
  cut: { top: number; bottom: number } | null;
  cheapest: { top: number; bottom: number; value: number } | null;
}

/**
 * Where the cut line and the cheapest legal claim sit at 375x812. The page is
 * put back at its top first: the point of the pin is that a reader who has not
 * scrolled the page can already see the cut, so measuring at scroll 0 tests the
 * promise rather than the test's own scroll history.
 */
async function ladderPin(page: Page): Promise<LadderPin> {
  return await page.evaluate(() => {
    const rect = (element: Element | null) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { top: Math.round(box.top), bottom: Math.round(box.bottom) };
    };
    window.scrollTo(0, 0);
    const legal = [...document.querySelectorAll<HTMLElement>(".announce:not([disabled])")];
    const cheapest = legal[legal.length - 1] ?? null;
    return {
      scrollY: window.scrollY,
      fold: window.innerHeight,
      cut: rect(document.querySelector(".ladder-cut")),
      cheapest: cheapest ? { ...rect(cheapest)!, value: Number(cheapest.dataset.value) } : null,
    };
  });
}

/**
 * The desktop layout sampled mid-game, on an announcing snapshot with the
 * ladder up.
 */
interface MidGameDesktop {
  columns: DesktopColumns;
  pin: LadderPin;
}

/**
 * Measure the desktop columns and the ladder pin during play.
 *
 * There is no resize listener and `pinLadder` runs only from `paint()`, so a
 * bare `setViewportSize(DESKTOP)` leaves the ladder's inline `max-height` sized
 * against the phone fold: the cut reads a phone-shaped box and proves nothing
 * about desktop. A reload delivers a fresh snapshot, which repaints (and
 * re-pins) the ladder at the new width before the measurement. It is the same
 * turn and the same standing claim, so the game state is unchanged.
 */
async function midGameDesktop(page: Page): Promise<MidGameDesktop> {
  await page.setViewportSize(DESKTOP);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".announce", { timeout: 15_000 });
  return { columns: await desktopColumns(page), pin: await ladderPin(page) };
}

/**
 * The showdown's promise: claimed and actual stand side by side, with the stamp
 * between the comparison and the verdict. Geometry only, so a mid-beat
 * animation frame cannot make it flaky — and the sides carry no text of their
 * own, which keeps the comparison from collapsing into a sentence.
 */
async function showdownLayout(page: Page): Promise<{ sideBySide: boolean; detail: string }> {
  return await page.evaluate(() => {
    const claimed = document.querySelector<HTMLElement>(".showdown-claimed");
    const actual = document.querySelector<HTMLElement>(".showdown-actual");
    const stamp = document.querySelector<HTMLElement>(".showdown-stamp");
    if (!claimed || !actual || !stamp) {
      return { sideBySide: false, detail: "missing claimed/actual/stamp" };
    }
    const c = claimed.getBoundingClientRect();
    const a = actual.getBoundingClientRect();
    const visible = Math.min(c.bottom, a.bottom) - Math.max(c.top, a.top);
    return {
      sideBySide: a.left >= c.right - 1 && visible > 0,
      detail: `claimed ${Math.round(c.left)}-${Math.round(c.right)} · actual ${Math.round(a.left)}-${Math.round(a.right)}`,
    };
  });
}

/**
 * The showdown frame CSS paints at `fraction` of its window, for one tone.
 *
 * The staging is a negative `animation-delay` derived from `--showdown-elapsed`,
 * so an off-screen clone of the live showdown mounted with that variable set is
 * the frame CSS would paint at that instant — no racing the live clock, and no
 * dependence on which tones the random dice happen to produce. Each tone's
 * verdict signal is read from the rule that owns it: a caught bluff strikes the
 * claimed chip red and rings it, a real Mia rings the claim brass, and a
 * believed claim glows the actual dice green.
 */
async function showdownFrame(
  page: Page,
  tone: "caught" | "believed" | "mia",
  fraction: number,
): Promise<{ stampOpacity: number; claimedStruck: boolean; claimedShadow: string; actualFilter: string }> {
  return await page.evaluate(
    ({ tone, fraction }) => {
      const live = document.querySelector<HTMLElement>(".showdown");
      if (!live) throw new Error("no live showdown to sample");
      const span = Number.parseFloat(live.style.getPropertyValue("--showdown-span")) || 0;
      const clone = live.cloneNode(true) as HTMLElement;
      clone.classList.remove("caught", "believed", "mia");
      clone.classList.add(tone);
      // Still rendered (visibility, not display) so the animation computes.
      clone.style.visibility = "hidden";
      clone.style.pointerEvents = "none";
      clone.style.setProperty("--showdown-elapsed", `${Math.round(span * fraction)}ms`);
      document.body.appendChild(clone);
      void clone.offsetWidth; // position the animation before reading it
      const read = (selector: string) => {
        const node = clone.querySelector<HTMLElement>(selector);
        return node ? getComputedStyle(node) : null;
      };
      const claimed = read(".showdown-claimed .showdown-value");
      const stamp = read(".showdown-stamp");
      const dice = read(".showdown-actual .dice");
      const frame = {
        stampOpacity: stamp ? Number(stamp.opacity) : -1,
        // `line-through` is on the base rule; its colour is what the beat-3
        // animation brings in, so a visible strike is a coloured one.
        claimedStruck:
          (claimed?.textDecorationLine.includes("line-through") ?? false) &&
          (claimed?.textDecorationColor ?? "").includes("226, 104, 95"),
        claimedShadow: claimed?.boxShadow ?? "",
        actualFilter: dice?.filter ?? "",
      };
      clone.remove();
      return frame;
    },
    { tone, fraction },
  );
}

/** One browser move, chosen from what is actually on screen. */
async function act(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const click = (element: HTMLElement | null) => element?.click();
    const shown = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      return element && !element.hasAttribute("disabled") ? element : null;
    };
    if (document.querySelector(".winner")) return "finished";

    const announce = [...document.querySelectorAll<HTMLElement>(".announce")].filter((b) => !b.hasAttribute("disabled"));
    if (announce.length > 0) {
      const mine = announce.find((button) => button.classList.contains("mine"));
      // Mostly tell the truth; sometimes bluff with the top legal claim, so
      // both reveal verdicts actually occur.
      const pick = mine && Math.random() < 0.65 ? mine : announce[0]!;
      click(pick);
      return `announce ${pick.dataset.value}`;
    }

    const doubt = shown('[data-action="doubt"]');
    const believe = shown('[data-action="believe"]');
    if (doubt || believe) {
      const takeDoubt = doubt !== null && (believe === null || Math.random() < 0.5);
      click(takeDoubt ? doubt : believe);
      return takeDoubt ? "doubt" : "believe";
    }
    if (shown('[data-action="roll"]')) {
      click(shown('[data-action="roll"]'));
      return "roll";
    }
    return "wait";
  });
}

async function playGame(page: Page, bots: ChildProcess, tableId: string): Promise<{ saw: Set<string>; secrecyViolations: string[]; claimBubbleViolations: string[]; countdownTicks: string[]; rerenderSurvived: boolean | null }> {
  section("A full game with bots");
  const saw = new Set<string>();
  const secrecyViolations: string[] = [];
  const claimBubbleViolations: string[] = [];
  const countdownTicks: string[] = [];
  let rerenderSurvived: boolean | null = null;
  let reconnected = false;
  let sawAnnounceCut = false;
  let midGameDesktopChecked = false;
  let sawSeatLayout = false;
  let miaVerdictChecked = false;
  const deadline = Date.now() + 12 * 60_000;

  await page.click('[data-action="start"]');
  while (Date.now() < deadline) {
    const snap = await snapshot(page);
    const firstTime = !saw.has(snap.phase);
    if (firstTime) {
      saw.add(snap.phase);
      const names: Record<string, string> = {
        roundStart: "04-round-start",
        deciding: "05-deciding",
        announcing: "06-announcing",
        revealing: "07-revealing",
        finished: "08-finished",
      };
      if (names[snap.phase]) await shot(page, names[snap.phase]);
      if (snap.phase === "revealing") {
        note(
          `07-revealing captured at beat ${snap.beat} (${snap.showdownTone}, elapsed ${snap.showdownElapsed}ms of ${snap.showdownSpan}ms)`,
        );
      }
    }
    // The ring is a visual arrangement, not a reading order: the harness still
    // reads one `.player` per seat. Pin the two properties the redesign owns —
    // the viewer is at the bottom, and a claim hangs on its claimant's chair.
    if (!sawSeatLayout && snap.seatCount > 0) {
      sawSeatLayout = true;
      check("the ring seats every player", snap.seatCount === SEATS, `${snap.seatCount} of ${SEATS} seats`);
      const layout = await seatLayout(page);
      check("your own seat is the bottom-most seat on the ring", layout.youIsBottom, layout.detail);
    }
    // The claim changes every turn and the bubble is rebuilt with it, so this
    // samples every snapshot carrying a claim rather than only the first: a
    // bubble that goes stale mid-game has to register, not just one wrong on
    // the opening render. Mismatches accumulate like `secrecyViolations` and
    // assert once after the loop, so hundreds of green samples do not bury a
    // failure.
    if (snap.standingClaimerId !== null && !(snap.claim.count === 1 && snap.claim.by === snap.standingClaimerId)) {
      claimBubbleViolations.push(
        `bubble ${snap.claim.count} on ${snap.claim.by ?? "none"} · claimer ${snap.standingClaimerId ?? "none"}`,
      );
    }
    // The ladder is rebuilt every turn and the standing claim moves, so the
    // legality check runs on every announcing snapshot, not only the first.
    if (snap.phase === "announcing") {
      // Rendered rungs are every value in RANKING; tappable rungs are the
      // subset without `disabled`. The legal set comes from the engine's own
      // ordering, not a numeric `>` — `65` standing permits `11`.
      const legal = legalClaims(snap.standingValue);
      const illegal = RANKING.filter((value) => !legal.includes(value));
      const rendered = snap.announce.values;
      const tappable = snap.announce.tappable;
      const disabled = snap.announce.disabled;
      // Capture the cut at least once; the first announcing turn may be the
      // round opener, which has no standing claim to cut against.
      if (!sawAnnounceCut && snap.standingValue !== null) {
        sawAnnounceCut = true;
        // Put the page at its top so the shot shows what a reader sees before
        // any page scroll; the pin is supposed to make that enough.
        await page.evaluate(() => window.scrollTo(0, 0));
        await shot(page, "06b-announcing-cut");
      }
      check(
        "the announce ladder renders every rung in ranking order",
        rendered.length === RANKING.length && rendered.every((value, index) => value === RANKING[index]),
        `${rendered.length} rungs`,
      );
      check(
        "the announce ladder's tappable rungs are exactly the legal claims",
        sameNumberSet(tappable, legal),
        `tappable [${tappable.join(", ")}] vs legal [${legal.join(", ")}] (standing ${
          snap.standingValue === null ? "none" : labelValue(snap.standingValue)
        })`,
      );
      check(
        "the announce ladder disables every below-the-cut rung",
        sameNumberSet(disabled, illegal),
        `disabled [${disabled.join(", ")}] vs illegal [${illegal.join(", ")}]`,
      );
      check(
        "the announce ladder cuts the ranking at the standing claim",
        snap.standingValue === null ? !snap.announce.hasCut : snap.announce.hasCut,
        `cut=${snap.announce.hasCut} standing=${snap.standingValue === null ? "none" : labelValue(snap.standingValue)}`,
      );
      check(
        "the cut rung matches the standing claim",
        snap.standingValue === null || snap.announce.standingRung === snap.standingValue,
        `rung=${snap.announce.standingRung} standing=${snap.standingValue}`,
      );
      check("the announce ladder keeps Mia distinct", snap.announce.values.includes(MIA) ? snap.announce.mia : true, `${rendered.length} rungs`);
      const ownCup = snap.players.some((player) => player.you && player.cup);
      check("the announce ladder marks your own roll", ownCup ? snap.announce.mine : true, ownCup ? `mine=${snap.announce.mine}` : "not holding the cup");
      const nameClipped = await page.evaluate(() => {
        const row = [...document.querySelectorAll<HTMLElement>(".player")].find((li) => li.querySelector(".name em"));
        const name = row?.querySelector<HTMLElement>(".name");
        return name ? name.scrollWidth > name.clientWidth + 1 : false;
      });
      check("your own name survives the cup, turn and countdown badges", nameClipped === false, String(nameClipped));
      const overlap = await playersActionsOverlap(page);
      check("the announce ladder does not cover the table", overlap === 0, `${overlap}px overlap`);
      // The cut has to be reachable without scrolling the page at all: a box
      // sized to `58vh` puts its bottom edge ~229px below a 812px fold, so the
      // cut and the cheapest legal claim fall off-screen. The worst case is a
      // full table, where the roster above the ladder is tallest.
      if (snap.standingValue !== null) {
        const pin = await ladderPin(page);
        const cutOnScreen = pin.cut !== null && pin.cut.top >= 0 && pin.cut.bottom <= pin.fold;
        const cheapestOnScreen = pin.cheapest !== null && pin.cheapest.top >= 0 && pin.cheapest.bottom <= pin.fold;
        check(
          "the pinned cut and cheapest legal claim are on screen at 375x812",
          pin.scrollY === 0 && cutOnScreen && cheapestOnScreen,
          `${snap.players.length} seats · fold ${pin.fold} · cut ${
            pin.cut ? `${pin.cut.top}-${pin.cut.bottom}` : "none"
          } · cheapest ${pin.cheapest ? `${labelValue(pin.cheapest.value)} ${pin.cheapest.top}-${pin.cheapest.bottom}` : "none"}`,
        );
      }
      // Once, on the first announcing snapshot with a standing claim. The
      // end-of-run desktop check only ever sees the finished screen — no
      // ladder, no claim bubbles and the shortest `.actions` card — so it
      // would stay green if the columns broke during play. The probe resizes
      // to desktop, so restore the phone viewport before the game continues;
      // the next snapshot repaints at 375px.
      if (!midGameDesktopChecked && snap.standingValue !== null) {
        midGameDesktopChecked = true;
        const { columns, pin } = await midGameDesktop(page);
        check(
          "MIDGAME: desktop three columns while the ladder is up",
          columns.sideBySide && columns.overlap === 0,
          columns.detail,
        );
        const midOverflow = await overflow(page);
        check("MIDGAME: no horizontal scroll on desktop", midOverflow === 0, `${midOverflow}px overflow`);
        // The gate above admits only a standing claim, so a null cut here is a
        // real failure: `pinLadder` cuts against the standing claim, and a
        // round opener would not reach this probe at all.
        const cutOnScreen = pin.cut !== null && pin.cut.top >= 0 && pin.cut.bottom <= pin.fold;
        const cheapestOnScreen = pin.cheapest !== null && pin.cheapest.top >= 0 && pin.cheapest.bottom <= pin.fold;
        check(
          "MIDGAME: ladder cut on screen at desktop",
          pin.scrollY === 0 && cutOnScreen && cheapestOnScreen,
          JSON.stringify({ fold: pin.fold, cut: pin.cut, cheapest: pin.cheapest }),
        );
        await page.setViewportSize(PHONE);
      }
    }
    if (firstTime && snap.phase === "revealing") {
      check("the reveal shows the claim, the actual dice and a verdict", snap.reveal.length > 0 && snap.verdict.length > 0, snap.verdict.slice(0, 80));
      // The staging this PR owns. The stamp is the engine's verdict: BLUFF when
      // the announcer's bluff was caught, TRUE/MIA when the doubter was wrong.
      check("the reveal is staged as a showdown", snap.showdown, `showdown=${snap.showdown}`);
      check(
        "the stamp names the engine's verdict",
        snap.verdictTone === "caught" ? snap.stamp === "BLUFF" : snap.stamp === "TRUE" || snap.stamp === "MIA",
        `${snap.stamp} / ${snap.verdictTone}`,
      );
      check(
        "a brass MIA stamp is the doubter's double loss",
        snap.stamp !== "MIA" || (snap.verdictTone === "believed" && snap.verdict.includes("Doubled")),
        snap.verdict.slice(0, 90),
      );
      const layout = await showdownLayout(page);
      check("claimed and actual stand side by side in the showdown", layout.sideBySide, layout.detail);
      // The staging's whole value is *when* the verdict appears, and every
      // other check here only tests *that* it appears. Read the first and last
      // beat for each tone from an off-screen clone, so a tone rule that leaks
      // the answer before the stamp lands cannot hide behind a benign reveal.
      const leaked: string[] = [];
      const missing: string[] = [];
      for (const tone of ["caught", "believed", "mia"] as const) {
        const start = await showdownFrame(page, tone, 0);
        const land = await showdownFrame(page, tone, 0.95);
        const startRing = start.claimedShadow.includes("226, 104, 95") || start.claimedShadow.includes("232, 196, 106");
        const startGlow = start.actualFilter.includes("111, 207, 151");
        const landDangerRing = land.claimedShadow.includes("226, 104, 95");
        const landGoldRing = land.claimedShadow.includes("232, 196, 106");
        const landGlow = land.actualFilter.includes("111, 207, 151");
        const verdictAtStart =
          tone === "caught" ? start.claimedStruck || startRing : tone === "mia" ? startRing : startGlow;
        const verdictAtLand =
          tone === "caught" ? land.claimedStruck && landDangerRing : tone === "mia" ? landGoldRing : landGlow;
        if (start.stampOpacity > 0.01) leaked.push(`${tone}: stamp up (${start.stampOpacity})`);
        if (verdictAtStart) leaked.push(`${tone}: verdict decoration on`);
        if (land.stampOpacity < 0.99) missing.push(`${tone}: stamp down (${land.stampOpacity})`);
        if (!verdictAtLand) missing.push(`${tone}: verdict decoration off`);
      }
      check(
        "the showdown withholds the verdict until the stamp lands",
        leaked.length === 0,
        leaked.join("; ") || "beat 1: stamp down and claimed neutral in all three tones",
      );
      check(
        "the showdown shows the verdict by beat 3",
        missing.length === 0,
        missing.join("; ") || "beat 3: stamp up and verdict decorated in all three tones",
      );
    }
    // A Mia claim is the one roll where the verdict must read "MIA" and never
    // "2·1". The dice are random, so this runs on whichever reveal shows one
    // rather than being gated on the first reveal, which is usually not Mia.
    if (!miaVerdictChecked && snap.phase === "revealing" && snap.revealClaimed.includes("MIA")) {
      miaVerdictChecked = true;
      check(
        "a Mia claim reads as MIA in the verdict, not 2·1",
        snap.verdict.includes("MIA") && !snap.verdict.includes("2·1"),
        snap.verdict.slice(0, 90),
      );
    }

    // The honest-player tally is news: a live stamp would tell the table
    // whether the standing claim (and every earlier one) was true. The
    // record is redacted until game over; this pins that the client does
    // not draw the shout from something else.
    if (snap.phase !== "finished" && (snap.honestBadge || snap.honestOnResultCard)) {
      check("the honest badge is not drawn mid-game", false, `${snap.phase}: ${snap.honestBadge}`);
    }

    // Secrecy: before a reveal, only "(you)" may have dice on screen.
    if (snap.phase === "deciding" || snap.phase === "announcing" || snap.phase === "roundStart") {
      const withDice = snap.players.filter((player) => player.dice);
      for (const player of withDice) {
        if (!player.you) secrecyViolations.push(`${player.name} showed dice to the browser in ${snap.phase}`);
      }
      if (withDice.filter((player) => player.you).length > 1) secrecyViolations.push("more than one own dice row");
    }

    if (snap.phase === "finished") {
      check("the game ends with a winner on screen", snap.winner.length > 0, snap.winner);
      // The honest-player stamp is rare (an all-truth win) and must not be
      // required: a random game almost never produces one, and requiring it
      // would be an assertion that cannot fail the other way. What we pin is
      // that it never appears off the result card, and that when luck does
      // produce it the sentence is the lookbook's.
      if (snap.honestBadge) {
        check(
          "the honest badge is the lookbook sentence on the result card",
          snap.honestBadge === "Never once bluffed" && snap.honestOnResultCard,
          `${snap.honestBadge} · on card: ${snap.honestOnResultCard}`,
        );
      } else {
        check("the honest badge is absent unless the winner never bluffed", !snap.honestOnResultCard);
      }
      // Eliminated players keep their chair: the count is every seat, not the
      // survivors, so an "only show the living" regression fails here.
      check(
        "every seat is still drawn at game over, including the eliminated",
        snap.seatCount === SEATS,
        `${snap.seatCount} of ${SEATS} seats · ${snap.players.filter((player) => player.out).length} out`,
      );
      // The replay. One claim per announcement of the final round, then exactly
      // one doubt and one truth. The counts alone do not say which round the
      // strip is of — `cells === claims + 2` holds however many rounds it
      // swallowed — so the claims are also walked: within one round every
      // announcement has to outrank the one standing, and a strip that crosses
      // a round boundary shows a claim that drops back down the ranking. That
      // climb is the assertion with teeth.
      const claimRanks = snap.film.claimValues.map(claimRank);
      check(
        "the filmstrip replays one round's claims, the doubt and the truth",
        snap.film.claims >= 1 &&
          snap.film.doubt === 1 &&
          snap.film.truth === 1 &&
          snap.film.cells === snap.film.claims + 2 &&
          claimRanks.every((value, index) => index === 0 || outranks(value, claimRanks[index - 1]!)),
        JSON.stringify(snap.film),
      );
      // The claims are derived from the event log and the felt's claim bubble
      // from `lastAnnouncement`: two sources for the same fact, so they have to
      // agree. That is what says the strip is the round that actually ended it.
      const lastClaim = snap.film.claimValues.at(-1) ?? "";
      check(
        "the filmstrip's last claim is the claim left standing on the felt",
        lastClaim.length > 0 && snap.claim.value === lastClaim,
        `felt ${snap.claim.value || "none"} vs filmstrip ${lastClaim || "none"}`,
      );
      check(
        "the filmstrip's caption names the truth the doubt turned over",
        snap.film.truthValue.length > 0 && snap.film.caption.includes(snap.film.truthValue),
        `${snap.film.truthValue} :: ${snap.film.caption.slice(0, 90)}`,
      );
      // The stats: one row per seat, the viewer's own marked, every line filled
      // in and none of them a broken calculation.
      check("the stats give every player at the table a row", snap.stats.rows === SEATS, `${snap.stats.rows} of ${SEATS}`);
      check("the stats mark the viewer's own row", snap.stats.you);
      check(
        "every stat line is filled in and none of them reads as a broken number",
        snap.stats.lines.length === SEATS &&
          snap.stats.lines.every((line) => line.length > 0) &&
          [...snap.stats.lines, ...snap.stats.chips].every((text) => !/NaN|undefined|\b0 times\b/.test(text)),
        snap.stats.lines.slice(0, 2).join(" | "),
      );
      await shot(page, "09-game-over");

      // The rematch. A press opens a *new* table and the link reaches this
      // socket through the snapshot; the new table's lobby is seeded with the
      // whole roster before anyone else clicks.
      if (!snap.rematch.button) {
        check("the rematch button is offered to a player at the table", false, "no [data-action=rematch]");
      } else {
        await page.click('[data-action="rematch"]');
        const join = await page
          .waitForSelector('[data-action="join-rematch"]', { timeout: 10_000 })
          .then((handle) => handle.getAttribute("href"))
          .catch(() => null);
        check(
          "a rematch press opens a different table and links to it",
          join !== null && join.startsWith("/t/") && join !== `/t/${tableId}`,
          `${join ?? "no link"} (from /t/${tableId})`,
        );
        await shot(page, "09b-rematch");
        if (join) {
          const rematchPage = await page.context().newPage();
          watch(rematchPage);
          await rematchPage.goto(new URL(join, page.url()).toString(), { waitUntil: "networkidle" });
          await rematchPage.waitForSelector(".roster-row", { timeout: 10_000 });
          const seats = await rematchPage.evaluate(() => document.querySelectorAll(".roster-row").length);
          const heading = (await rematchPage.textContent(".room-card h2"))?.trim() ?? "";
          check(
            "the rematch table is pre-seeded with the whole roster",
            seats === SEATS,
            `${seats} of ${SEATS} seats · ${heading}`,
          );
          check("the rematch table keeps the table's name", heading === "R1 table", heading);
          await shot(rematchPage, "09c-rematch-lobby");
          await rematchPage.close();
        }
      }
      break;
    }

    // Once, mid-game: prove a reload restores the live state with no extra seat.
    if (!reconnected && snap.phase === "revealing" && snap.round >= 1) {
      reconnected = true;
      const before = snap.players.length;
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector(".players, .winner", { timeout: 15_000 });
      const after = await snapshot(page);
      check("a mid-game reload restores the live state", after.round === snap.round && after.phase !== "roundStart", `round ${snap.round} -> ${after.round}, ${snap.phase} -> ${after.phase}`);
      check("a mid-game reload adds no duplicate seat", after.players.length === before, `${before} -> ${after.players.length}`);
      await shot(page, "10-reconnect");
    }

    // Countdown + re-render evidence: freeze the bots so no snapshots arrive,
    // then prove the clock ticks without the page being rebuilt beneath it.
    const waitingOnBot = snap.players.some((player) => player.turn && !player.you);
    if (rerenderSurvived === null && snap.countdown !== null && waitingOnBot) {
      bots.kill("SIGSTOP");
      await sleep(600); // let any in-flight broadcast land first
      let evidence: { survived: boolean | null; ticks: string[] };
      try {
        evidence = await page.evaluate(async () => {
          // The controls card is the marker: every in-play snapshot renders one,
          // and it is the card a stale re-render would replace.
          const node = document.querySelector<HTMLElement>(".actions");
          if (!node) return { survived: null as boolean | null, ticks: [] as string[] };
          (node as unknown as { __r1: boolean }).__r1 = true;
          const ticks: string[] = [];
          const read = () => document.querySelector("[data-countdown]")?.textContent?.trim() ?? null;
          for (let i = 0; i < 16 && ticks.length < 3; i++) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            const value = read();
            if (value !== null && value !== ticks[ticks.length - 1]) ticks.push(value);
          }
          const stillThere =
            (document.querySelector(".actions") as unknown as { __r1?: boolean } | null)?.__r1 === true;
          return { survived: stillThere, ticks };
        });
      } finally {
        bots.kill("SIGCONT");
      }
      rerenderSurvived = evidence.survived;
      countdownTicks.push(...evidence.ticks);
    }

    const action = await act(page);
    if (action === "wait") await sleep(300);
    else await sleep(200);
  }

  if (!saw.has("finished")) note("the game did not finish inside the time box");
  return { saw, secrecyViolations, claimBubbleViolations, countdownTicks, rerenderSurvived };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  watch(page);

  await verifyLobby(page);
  const tableId = await createTableThroughUi(page);

  section("Table (waiting for players)");
  await page.waitForSelector(".room-card");
  await shot(page, "02-table-waiting");
  check("the waiting room shows the share control", (await page.$('[data-action="share"]')) !== null);

  await verifyShare(page, context, browser, tableId);
  await verifyCreatorCanStart(browser);

  // Fill the table *after* the share step: a fresh session needs a free seat,
  // and the game should run at the largest roster so the ladder geometry is
  // tested where it is worst.
  section(`Filling the table to ${SEATS} seats`);
  console.log(`\n  starting ${BOTS} bot${BOTS === 1 ? "" : "s"} for ${tableId}…`);
  const bots: ChildProcess = spawn("node", ["scripts/bots.ts", tableId, String(BOTS)], { stdio: "inherit", env: process.env });
  await page.waitForFunction((expected) => document.querySelectorAll(".roster-row").length === expected, SEATS, { timeout: 30_000 });
  check(`${BOTS} bots appear in the roster`, true, `${SEATS} seats`);
  await shot(page, "02b-table-with-bots");

  const game = await playGame(page, bots, tableId);
  check("every table phase rendered", ["roundStart", "deciding", "announcing", "revealing", "finished"].every((phase) => game.saw.has(phase)), [...game.saw].join(", "));
  check("no other player's dice were ever on screen before a reveal", game.secrecyViolations.length === 0, game.secrecyViolations.slice(0, 3).join("; "));
  check("the claim bubble hangs on the seat that made the claim", game.claimBubbleViolations.length === 0, game.claimBubbleViolations.slice(0, 3).join("; "));
  check("the countdown ticks down", game.countdownTicks.length >= 3, game.countdownTicks.join(" -> "));
  check("the page is not re-rendered every second", game.rerenderSurvived === true, game.rerenderSurvived === null ? "no countdown observed" : String(game.rerenderSurvived));

  section("Phone fitness");
  check("no horizontal scroll at 375px on the table", (await overflow(page)) === 0, `${await overflow(page)}px overflow`);
  const smallTargets = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, a.link, a.primary")]
      .filter((element) => element.offsetParent !== null)
      .map((element) => ({ label: (element.textContent ?? "").trim().slice(0, 24), height: Math.round(element.getBoundingClientRect().height), width: Math.round(element.getBoundingClientRect().width) }))
      .filter((target) => target.height < 40 && target.width < 90),
  );
  check("tap targets are comfortably sized", smallTargets.length === 0, JSON.stringify(smallTargets.slice(0, 4)));
  await page.setViewportSize(WIDE);
  await sleep(300);
  await shot(page, "11-wide-768");
  check("nothing collapses at 768px", (await overflow(page)) === 0, `${await overflow(page)}px overflow`);

  // The 768px check above is below the 900px breakpoint, so it never reaches
  // the three-column regime. This one is genuinely wide and pins the layout the
  // breakpoint owns: controls, felt and log in three non-overlapping bands.
  await page.setViewportSize(DESKTOP);
  await sleep(300);
  await shot(page, "13-wide-desktop");
  const columns = await desktopColumns(page);
  check(
    "the desktop viewport lays the table out in three side-by-side columns",
    columns.sideBySide && columns.overlap === 0,
    columns.detail,
  );
  check(
    "the desktop columns keep a real width",
    columns.widths.length === 3 && columns.widths.every((width) => width > 100),
    `${columns.widths.join(" / ")}px`,
  );
  check("no horizontal scroll at the desktop width", (await overflow(page)) === 0, `${await overflow(page)}px overflow`);

  section("Console");
  check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 4).join(" | "));
  check("no unhandled page errors", pageErrors.length === 0, pageErrors.slice(0, 4).join(" | "));

  bots.kill("SIGINT");
  await sleep(300);
  bots.kill("SIGKILL");
  await browser.close();

  section("Summary");
  const failed = steps.filter((step) => !step.ok);
  console.log(`  ${steps.length - failed.length}/${steps.length} checks passed`);
  for (const step of failed) console.log(`  FAILED: ${step.name}${step.detail ? ` — ${step.detail}` : ""}`);
  for (const message of notes) console.log(`  note: ${message}`);
  if (consoleErrors.length > 0) console.log(`  console errors:\n    ${consoleErrors.join("\n    ")}`);
  if (pageErrors.length > 0) console.log(`  page errors:\n    ${pageErrors.join("\n    ")}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("\nui-check crashed:", error);
  process.exitCode = 1;
});
