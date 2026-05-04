/**
 * `@servicecute/surrealdb-seed` — SurrealDB adapter for the seed
 * runner. Implements `DbBackend` from `@servicecute/seed-core` against
 * the `surrealdb` npm package.
 *
 * **Scaffolding only.** Every method throws "not implemented yet" —
 * see seed-ts/tasks.md (T1.x).
 */

export { SurrealBackend } from "./backend.js";
export { SurrealTracking } from "./tracking.js";
export { SurrealLock } from "./lock.js";
export { schemaForSurreal } from "./schema.js";

/** Tracking + lock table names per spec §10.1. */
export const SEEDS_TABLE = "__seeds";
export const SEEDS_LOCK_TABLE = "__seeds_lock";
