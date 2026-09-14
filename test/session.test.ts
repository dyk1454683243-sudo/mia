/**
 * Session-key creation. The failure this pins: on a cold database two isolates
 * both see a missing key, both generate one, and the second write overwrites the
 * first — silently invalidating every cookie already signed with the loser.
 */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureSchema, getConfig, insertConfigIfAbsent } from "../src/worker/db";
import { resolveSigningKeyMaterial, SIGNING_KEY_CONFIG } from "../src/worker/session";

describe("signing key", () => {
  // Schema setup belongs outside the tests: storage is isolated per test file and
  // is not rolled back between tests in a file, so creating the tables in the
  // first test would work by accident and break the moment tests are reordered.
  beforeAll(async () => {
    await ensureSchema(env);
  });

  it("creates a config value once and never overwrites it", async () => {
    await env.DB.prepare(`DELETE FROM app_config WHERE key = ?1`).bind("write-once").run();
    await insertConfigIfAbsent(env, "write-once", "first");
    await insertConfigIfAbsent(env, "write-once", "second");
    // An upsert would leave "second" here and invalidate the first signer.
    expect(await getConfig(env, "write-once")).toBe("first");
  });

  it("converges two concurrent first requests on one key", async () => {
    await env.DB.prepare(`DELETE FROM app_config WHERE key = ?1`).bind(SIGNING_KEY_CONFIG).run();
    const [a, b] = await Promise.all([resolveSigningKeyMaterial(env), resolveSigningKeyMaterial(env)]);
    expect(a).toBe(b);
    expect(await getConfig(env, SIGNING_KEY_CONFIG)).toBe(a);
  });
});
