/**
 * `@servicecute/firestore-seed` — Firestore adapter for the seed
 * runner. Implements `DbBackend` from `@servicecute/seed-core`
 * against `firebase-admin`.
 *
 * **Scaffolding only.** Every method throws "not implemented yet" —
 * see seed-ts/tasks.md (T4.x).
 */

export { FirestoreBackend } from "./backend.js";
export { FirestoreTracking } from "./tracking.js";
export { FirestoreLock } from "./lock.js";

/** Tracking + lock doc IDs per spec §10.2. */
export const SEEDS_COLLECTION = "__seeds";
export const APPLY_LOCK_DOC = "_lock_apply";
export const REGENERATE_LOCK_DOC = "_lock_regenerate";
