/**
 * Session identity HTTP: GET / PATCH / POST /api/me.
 *
 * POST is the drawn-name path the waiting-room reroll shares — another Culture
 * ship, not a submitted string. Storage is isolated per file, not per test.
 */
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { SHIP_NAMES } from "../src/shared/ships";
import { ensureSchema, getPlayer } from "../src/worker/db";
import { signCookie } from "../src/worker/session";

async function makePlayer(name: string): Promise<{ id: string; cookie: string }> {
  const id = crypto.randomUUID();
  await ensureSchema(env);
  await env.DB.prepare(`INSERT INTO players (id, name, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?3)`)
    .bind(id, name, Date.now())
    .run();
  return { id, cookie: `mia_pid=${await signCookie(env, id)}` };
}

describe("POST /api/me", () => {
  beforeAll(async () => {
    await ensureSchema(env);
  });

  it("draws a different ship name and persists it", async () => {
    const player = await makePlayer("Slightly Wet");

    const response = await SELF.fetch("https://mia.test/api/me", {
      method: "POST",
      headers: { Cookie: player.cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; name: string };
    expect(body.id).toBe(player.id);
    expect(body.name).not.toBe("Slightly Wet");
    expect(SHIP_NAMES).toContain(body.name);

    const row = await getPlayer(env, player.id);
    expect(row?.name).toBe(body.name);

    const again = await SELF.fetch("https://mia.test/api/me", { headers: { Cookie: player.cookie } });
    expect(((await again.json()) as { name: string }).name).toBe(body.name);
  });
});
