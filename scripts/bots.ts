/**
 * Seat bots at a table a human is playing at.
 *
 *   node scripts/bots.ts <tableId> [count]     (default count: 2)
 *
 * The bots join the table and then wait: the human at the browser opens the
 * game. From then on every non-human seat is played by the same strategy the
 * e2e harness uses, so the browser player gets a real game. The process stays
 * attached after the game ends — Ctrl-C to leave.
 *
 * They share the WebSocket client and the strategy with `scripts/e2e.ts`
 * through `scripts/lib.ts`; this file only drives them.
 */
import { MAX_PLAYERS, type MiaState } from "../src/shared/mia.ts";
import { api, chooseAction, Client, createPlayer, makeRandom, nextSnapshot } from "./lib.ts";

const tableId = process.argv[2] ?? "";
const count = Number(process.argv[3] ?? "2");
/** Give up if the human never starts the game. */
const START_TIMEOUT_MS = 30 * 60_000;
/** Give up if the table stops moving for this long mid-game. */
const STALL_MS = 5 * 60_000;

if (!tableId) {
  console.error("usage: node scripts/bots.ts <tableId> [count]");
  process.exit(1);
}
if (!Number.isInteger(count) || count < 1 || count > MAX_PLAYERS - 1) {
  console.error(`count must be an integer from 1 to ${MAX_PLAYERS - 1} (a table seats ${MAX_PLAYERS} including you)`);
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const players = [];
  for (let index = 0; index < count; index++) {
    const player = await createPlayer(`bot${index + 1}`);
    // A recognisable name makes the browser side of a verification obvious.
    const renamed = await api("/api/me", {
      method: "PATCH",
      player,
      body: JSON.stringify({ name: `Bot ${index + 1}` }),
    });
    if (renamed.status === 200) player.name = (renamed.body as { name: string }).name;
    players.push(player);
  }

  const clients = players.map((player) => new Client(player));
  await Promise.all(clients.map((client) => client.connect(tableId)));
  console.log(`  seated ${count} bot${count === 1 ? "" : "s"} at ${tableId}: ${players.map((p) => p.name).join(", ")}`);

  const refused = clients.find((client) => client.lastError !== null);
  if (refused) {
    console.error(`  ${refused.player.name} was refused: ${refused.lastError}`);
    console.error("  bots must join before the game starts — create the table first, then run this.");
    clients.forEach((client) => client.close());
    process.exitCode = 1;
    return;
  }

  /** Whichever client has seen the most events is the freshest view of the game. */
  const freshest = (): MiaState | null => {
    let best: MiaState | null = null;
    for (const client of clients) {
      const view = client.state;
      if (view && (best === null || view.logSeq > best.logSeq)) best = view;
    }
    return best;
  };

  console.log("  waiting for you to start the game in the browser…");
  await Promise.race(
    clients.map((client) => client.waitFor((state) => state.round >= 1, START_TIMEOUT_MS).catch(() => undefined)),
  );
  const started = freshest();
  if (!started || started.round < 1) {
    console.error("  the game never started; leaving.");
    clients.forEach((client) => client.close());
    process.exitCode = 1;
    return;
  }
  console.log(`  round ${started.round} is under way — playing ${count} seat${count === 1 ? "" : "s"}`);

  const random = makeRandom(Number(process.env.MIA_SEED ?? "20260912"));
  let lastSeq = -1;
  let lastProgress = Date.now();

  for (;;) {
    const state = freshest();
    if (state === null) {
      await nextSnapshot(clients, 10_000);
      continue;
    }
    if (state.gameOver) {
      console.log(`  game over — ${state.gameOver.winnerName} wins. Ctrl-C to leave.`);
      break;
    }
    if (state.logSeq !== lastSeq) {
      lastSeq = state.logSeq;
      lastProgress = Date.now();
    } else if (Date.now() - lastProgress > STALL_MS) {
      const errors = clients.map((client) => client.lastError).filter(Boolean).join("; ");
      throw new Error(`no progress for ${STALL_MS}ms at round ${state.round} phase ${state.phase} (${errors || "no errors"})`);
    }

    // Act only through the client whose own view says it is that client's turn:
    // reading the turn from one view and acting through another races the
    // broadcast and looks like a stall.
    const actor = clients.find((client) => {
      const mine = client.state;
      return (
        mine !== null &&
        mine.gameOver === null &&
        mine.turnPlayerId === client.player.id &&
        (mine.phase === "deciding" || mine.phase === "announcing")
      );
    });

    if (!actor) {
      await nextSnapshot(clients, 10_000);
      continue;
    }

    const mine = actor.state!;
    const action = chooseAction(mine, actor.player.id, random);
    if (!action) throw new Error(`no legal move for ${actor.player.name} in phase ${mine.phase}`);

    actor.resetErrors();
    actor.send(action);
    try {
      // Every accepted action broadcasts and every refusal rejects this waiter,
      // so the next snapshot is the server's answer either way.
      await actor.waitNext(() => true, 10_000);
      if (action.type === "announce" || action.type === "doubt") {
        const said = action.type === "announce" ? `announces ${action.value}` : "doubts";
        console.log(`  ${actor.player.name} ${said}`);
      }
    } catch {
      // Refused or the snapshot was lost; re-read and decide again rather than
      // replaying a plan built from a state the server has moved past.
      await nextSnapshot(clients, 2_000);
    }
    await sleep(250); // a human is watching; don't blur past the table
  }

  // Stay attached so the finished table keeps all its seats connected while the
  // browser looks at it, until the operator ends the process.
  await new Promise<void>(() => {});
}

process.on("SIGINT", () => {
  console.log("\n  leaving the table.");
  process.exit(0);
});

main().catch((error) => {
  console.error("\nbots crashed:", error);
  process.exitCode = 1;
});
