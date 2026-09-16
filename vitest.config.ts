import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    // Vitest 4 spells this `projects`; the two suites need different runtimes.
    projects: [
      {
        // Pure rules engine and client helpers: plain Node, no Workers runtime.
        test: {
          name: "unit",
          root,
          environment: "node",
          include: ["test/mia.test.ts", "test/clock.test.ts", "test/seat-limits.test.ts"],
        },
      },
      {
        // Durable Object integration: runs inside workerd with a real D1.
        // `isolatedStorage` no longer exists here: from pool-workers 0.13.0
        // storage is isolated per test file, not per test.
        plugins: [
          cloudflareTest({
            main: "test/worker-entry.ts",
            miniflare: {
              compatibilityDate: "2026-09-12",
              d1Databases: { DB: "mia-test-db" },
              durableObjects: {
                TABLE: { className: "TestTableRoom", useSQLite: true },
              },
            },
          }),
        ],
        test: {
          name: "workers",
          root,
          include: ["test/room.test.ts", "test/session.test.ts", "test/tables.test.ts", "test/headers.test.ts"],
        },
      },
    ],
  },
});
