/**
 * Forged-header regression for the table WebSocket upgrade.
 *
 * The Worker is the only party allowed to say who a socket is: before it
 * forwards the upgrade it overwrites six `X-Mia-*` headers with values derived
 * from the signed session cookie and the D1 `tables` row. `Headers.set` replaces
 * a client-supplied value; `Headers.append` would preserve it, and the Durable
 * Object has no way to tell a forwarded header from a client-supplied one. This
 * drives the real Worker entrypoint with all six headers forged and reads the
 * state the Durable Object actually built. `X-Mia-Spectator` cannot escalate —
 * it only ever drops a seat — but the object still hears the Worker's value, not
 * the client's copy. See issue #24 and #45.
 */
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_PLAYERS, type MiaState } from "../src/shared/mia";
import { ensureSchema } from "../src/worker/db";
import { signCookie } from "../src/worker/session";
import { TestTableRoom } from "./table-room-test";

/** Mint a signed session cookie plus a matching players row. */
async function makePlayer(name: string): Promise<{ id: string; name: string; cookie: string }> {
  const id = crypto.randomUUID();
  await ensureSchema(env);
  await env.DB.prepare(`INSERT INTO players (id, name, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?3)`)
    .bind(id, name, Date.now())
    .run();
  return { id, name, cookie: `mia_pid=${await signCookie(env, id)}` };
}

async function createTableRow(name: string, hostId: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await ensureSchema(env);
  await env.DB.prepare(
    `INSERT INTO tables (id, name, host_id, status, player_count, max_players, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'waiting', 0, ${MAX_PLAYERS}, ?4, ?4)`,
  )
    .bind(id, name, hostId, now)
    .run();
  return id;
}

/** Read the unredacted state the Durable Object built for `tableId`. */
async function readState(tableId: string): Promise<MiaState | null> {
  return await runInDurableObject(env.TABLE.getByName(tableId), async (instance) => {
    return await (instance as TestTableRoom).__stateForTest();
  });
}

describe("forged X-Mia-* headers on the table upgrade", () => {
  beforeAll(async () => {
    await ensureSchema(env);
  });

  it("cannot impersonate the cookie's player or the table's D1 record", async () => {
    const host = await makePlayer("Canonical Host");
    const player = await makePlayer("Canonical Player");
    const tableId = await createTableRow("Canonical Table", host.id);

    const response = await SELF.fetch(`https://mia.test/api/tables/${tableId}/ws`, {
      headers: {
        Upgrade: "websocket",
        Cookie: player.cookie,
        // Every header the Worker forwards, forged to a different value.
        "X-Mia-Player": "forged-player-id",
        "X-Mia-Name": encodeURIComponent("Forged Player"),
        "X-Mia-Table-Name": encodeURIComponent("Forged Table"),
        "X-Mia-Table-Id": "forged-table-id",
        "X-Mia-Host-Id": "forged-host-id",
        // No `?watch=1` on the URL, so the canonical value is "0": a forged
        // spectator header must not stop this socket from being seated.
        "X-Mia-Spectator": "1",
      },
    });
    expect(response.status).toBe(101);
    response.webSocket?.accept();

    const state = await readState(tableId);
    expect(state).not.toBeNull();
    // The Durable Object sees the canonical header values, not the forged ones.
    // Under `append` these become "forged, canonical" and every check fails.
    expect(state!.tableId).toBe(tableId);
    expect(state!.tableName).toBe("Canonical Table");
    expect(state!.hostId).toBe(host.id);
    expect(state!.players.map((candidate) => candidate.id)).toEqual([player.id]);
    expect(state!.players[0]?.name).toBe("Canonical Player");

    response.webSocket?.close(1000, "test done");
  });
});
