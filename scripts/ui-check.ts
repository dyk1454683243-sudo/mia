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
import { api, BASE, createPlayer } from "./lib.ts";

const OUT = process.env.MIA_UI_OUT ?? ".r1-screenshots";
const PHONE = { width: 375, height: 812 };
const WIDE = { width: 768, height: 1024 };
mkdirSync(OUT, { recursive: true });

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

  // The copied link joins the table from a brand-new session.
  const fresh = await browser.newContext({ viewport: PHONE });
  const freshPage = await fresh.newPage();
  watch(freshPage);
  await freshPage.goto(copied, { waitUntil: "networkidle" });
  await freshPage.waitForSelector(".room-card", { timeout: 10_000 });
  const heading = (await freshPage.textContent(".room-card h2"))?.trim();
  const seats = await freshPage.evaluate(() => document.querySelectorAll(".roster-row").length);
  check("the shared link joins the table in a fresh session", heading === "R1 table" && seats >= 3, `${heading} · ${seats} seats`);
  await shot(freshPage, "03-fresh-session-join");
  await fresh.close();
  // B5: closing that session frees its pre-game seat again.
  await page.waitForFunction(() => document.querySelectorAll(".roster-row").length === 3, undefined, { timeout: 15_000 });
  check("closing the fresh session frees its seat", true);
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
  reveal: string;
  revealClaimed: string;
  verdict: string;
  winner: string;
  announce: { values: number[]; mia: boolean; mine: boolean; tappable: number[]; aboveStanding: boolean };
  players: { name: string; you: boolean; dice: boolean; cup: boolean; out: boolean; turn: boolean; lives: number }[];
}

async function snapshot(page: Page): Promise<Snapshot> {
  return await page.evaluate(() => {
    const text = (selector: string) => document.querySelector(selector)?.textContent?.trim() ?? "";
    const enabled = (element: Element) => !element.hasAttribute("disabled");
    const buttons = [...document.querySelectorAll<HTMLElement>(".announce")];
    const values = buttons.map((button) => Number(button.dataset.value));
    const standingText = text(".standing");
    const standingValue = standingText === "nothing yet" ? null : Number(standingText.replace(/\D/g, "")) || null;
    const players = [...document.querySelectorAll<HTMLElement>(".player")].map((row) => ({
      name: row.querySelector(".name")?.textContent?.trim() ?? "",
      you: row.querySelector(".name em") !== null,
      dice: row.querySelector(".player-dice") !== null,
      cup: row.querySelector(".badge.cup") !== null,
      out: row.classList.contains("out"),
      turn: row.classList.contains("turn"),
      lives: row.querySelectorAll(".pip.on").length,
    }));
    const actions = text(".actions");
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
      reveal: text(".reveal"),
      revealClaimed: text(".reveal-dice"),
      verdict: text(".verdict"),
      winner: text(".winner"),
      announce: {
        values,
        mia: document.querySelector(".announce.mia") !== null,
        mine: document.querySelector(".announce.mine") !== null,
        tappable: buttons.filter(enabled).map((button) => Number(button.dataset.value)),
        aboveStanding:
          standingValue === null ? true : values.every((value) => value > standingValue),
      },
      players,
    } as Snapshot;
  });
}

/** Overlap in CSS pixels between the players card and the actions card. */
async function playersActionsOverlap(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const players = document.querySelector(".players")?.closest(".card")?.getBoundingClientRect();
    const actions = document.querySelector(".actions")?.getBoundingClientRect();
    if (!players || !actions) return 0;
    const vertical = Math.min(players.bottom, actions.bottom) - Math.max(players.top, actions.top);
    const horizontal = Math.min(players.right, actions.right) - Math.max(players.left, actions.left);
    return Math.max(0, Math.round(Math.min(vertical, horizontal)));
  });
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
      // Mostly tell the truth; sometimes bluff with the lowest legal claim, so
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

async function playGame(page: Page, bots: ChildProcess): Promise<{ saw: Set<string>; secrecyViolations: string[]; countdownTicks: string[]; rerenderSurvived: boolean | null }> {
  section("A full game with bots");
  const saw = new Set<string>();
  const secrecyViolations: string[] = [];
  const countdownTicks: string[] = [];
  let rerenderSurvived: boolean | null = null;
  let reconnected = false;
  const deadline = Date.now() + 12 * 60_000;

  await page.click('[data-action="start"]');
  while (Date.now() < deadline) {
    const snap = await snapshot(page);
    if (!saw.has(snap.phase)) {
      saw.add(snap.phase);
      const names: Record<string, string> = {
        roundStart: "04-round-start",
        deciding: "05-deciding",
        announcing: "06-announcing",
        revealing: "07-revealing",
        finished: "08-finished",
      };
      if (names[snap.phase]) await shot(page, names[snap.phase]);
      if (snap.phase === "announcing") {
        check("the announce grid only offers values above the standing claim", snap.announce.aboveStanding, snap.standing);
        check("the announce grid keeps Mia distinct", snap.announce.values.includes(21) ? snap.announce.mia : true, `${snap.announce.values.length} buttons`);
        const ownCup = snap.players.some((player) => player.you && player.cup);
        check("the announce grid marks your own roll", ownCup ? snap.announce.mine : true, ownCup ? `mine=${snap.announce.mine}` : "not holding the cup");
        const nameClipped = await page.evaluate(() => {
          const row = [...document.querySelectorAll<HTMLElement>(".player")].find((li) => li.querySelector(".name em"));
          const name = row?.querySelector<HTMLElement>(".name");
          return name ? name.scrollWidth > name.clientWidth + 1 : false;
        });
        check("your own name survives the cup, turn and countdown badges", nameClipped === false, String(nameClipped));
        const overlap = await playersActionsOverlap(page);
        check("the announce grid does not cover the table", overlap === 0, `${overlap}px overlap`);
      }
      if (snap.phase === "revealing") {
        check("the reveal shows the claim, the actual dice and a verdict", snap.reveal.length > 0 && snap.verdict.length > 0, snap.verdict.slice(0, 80));
        if (snap.revealClaimed.includes("MIA")) {
          check(
            "a Mia claim reads as MIA in the verdict, not 2·1",
            snap.verdict.includes("MIA") && !snap.verdict.includes("2·1"),
            snap.verdict.slice(0, 90),
          );
        }
      }
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
      await shot(page, "09-game-over");
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
          const node = document.querySelector<HTMLElement>(".actions") ?? document.querySelector<HTMLElement>(".standing-card");
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
            (document.querySelector(".actions") as unknown as { __r1?: boolean } | null)?.__r1 === true ||
            (document.querySelector(".standing-card") as unknown as { __r1?: boolean } | null)?.__r1 === true;
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
  return { saw, secrecyViolations, countdownTicks, rerenderSurvived };
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

  console.log(`\n  starting bots for ${tableId}…`);
  const bots: ChildProcess = spawn("node", ["scripts/bots.ts", tableId, "2"], { stdio: "inherit", env: process.env });
  await page.waitForFunction(() => document.querySelectorAll(".roster-row").length === 3, undefined, { timeout: 30_000 });
  check("both bots appear in the roster", true, "3 seats");
  await shot(page, "02b-table-with-bots");

  await verifyShare(page, context, browser, tableId);
  await verifyCreatorCanStart(browser);

  const game = await playGame(page, bots);
  check("every table phase rendered", ["roundStart", "deciding", "announcing", "revealing", "finished"].every((phase) => game.saw.has(phase)), [...game.saw].join(", "));
  check("no other player's dice were ever on screen before a reveal", game.secrecyViolations.length === 0, game.secrecyViolations.slice(0, 3).join("; "));
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
