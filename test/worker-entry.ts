/**
 * The worker under test. It is the production handler plus the test-only
 * Durable Object subclass, which `vitest.config.ts` binds as `TABLE`. The
 * production entrypoint never imports or exports any of it, so nothing
 * test-shaped reaches a deployed bundle.
 */
export { default } from "../src/worker/index";
export { TestTableRoom } from "./table-room-test";
