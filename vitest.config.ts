import { fileURLToPath } from "node:url";
import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    // Vitest 3.0 spells this `workspace`; the two suites need different runtimes.
    workspace: [
      {
        // Pure rules engine: plain Node, no Workers runtime needed.
        test: {
          name: "unit",
          root,
          environment: "node",
          include: ["test/mia.test.ts"],
        },
      },
      defineWorkersProject({
        // Durable Object integration: runs inside workerd with a real D1.
        test: {
          name: "workers",
          root,
          include: ["test/room.test.ts"],
          poolOptions: {
            workers: {
              main: "src/worker/index.ts",
              isolatedStorage: true,
              miniflare: {
                compatibilityDate: "2026-09-12",
                d1Databases: { DB: "mia-test-db" },
                durableObjects: {
                  TABLE: { className: "TableRoom", useSQLite: true },
                },
              },
            },
          },
        },
      }),
    ],
  },
});
