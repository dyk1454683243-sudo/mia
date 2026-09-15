/**
 * The table-directory wire contract. `TableSummary` used to carry a
 * `hostName` that every caller left at its `"someone"` placeholder: a declared
 * field that was neither populated nor consumed. These tests pin its removal
 * from both routes that publish a summary, and keep `hostId` as the one way to
 * resolve the creator.
 */
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureSchema } from "../src/worker/db";
import { signCookie } from "../src/worker/session";

/** Mint a signed session cookie plus a matching players row. */
async function makePlayer(name: string): Promise<{ id: string; cookie: string }> {
  const id = crypto.randomUUID();
  await ensureSchema(env);
  await env.DB.prepare(`INSERT INTO players (id, name, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?3)`)
    .bind(id, name, Date.now())
    .run();
  return { id, cookie: `mia_pid=${await signCookie(env, id)}` };
}

/** Create a table as `host` and return its id. */
async function createTable(host: { cookie: string }, name: string): Promise<string> {
  const response = await SELF.fetch("https://mia.test/api/tables", {
    method: "POST",
    headers: { Cookie: host.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

describe("table directory summaries", () => {
  beforeAll(async () => {
    await ensureSchema(env);
  });

  it("does not carry a placeholder hostName in GET /api/tables", async () => {
    const host = await makePlayer("Listing host");
    const id = await createTable(host, "Listing table");

    const response = await SELF.fetch("https://mia.test/api/tables", { headers: { Cookie: host.cookie } });
    expect(response.status).toBe(200);

    const { tables } = (await response.json()) as { tables: Record<string, unknown>[] };
    const summary = tables.find((table) => table.id === id);
    expect(summary).toBeDefined();
    // hostId still identifies the creator; the dead hostName field is gone.
    expect(summary?.hostId).toBe(host.id);
    expect(summary).not.toHaveProperty("hostName");
  });

  it("does not carry a placeholder hostName in GET /api/tables/:id", async () => {
    const host = await makePlayer("Detail host");
    const id = await createTable(host, "Detail table");

    const response = await SELF.fetch(`https://mia.test/api/tables/${id}`, { headers: { Cookie: host.cookie } });
    expect(response.status).toBe(200);

    const summary = (await response.json()) as Record<string, unknown>;
    expect(summary.id).toBe(id);
    expect(summary.hostId).toBe(host.id);
    expect(summary).not.toHaveProperty("hostName");
  });
});
