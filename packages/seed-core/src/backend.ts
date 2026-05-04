import type { Lock } from "./lock.js";
import type { Tracking } from "./tracking.js";

/** One record about to be written. */
export interface WriteRequest {
  table: string;
  key: string;
  data: unknown;
}

export interface WriteResult {
  pathsTouched: string[];
  recordCount: number;
}

/** §12 path-missing-aware delete result. */
export interface DeleteResult {
  deleted: string[];
  missing: string[];
}

/**
 * The `DbBackend` seam. Each adapter implements this interface; the
 * runner reaches every backend-specific operation through it
 * (§4 + §10).
 */
export interface DbBackend {
  /** Borrowed handle for short-lived synchronous calls. */
  tracking(): Tracking;
  lock(): Lock;
  /**
   * Idempotently ensure both the tracking and lock storage exist with
   * the expected shape. Default delegates to `tracking().setup()` +
   * `lock().setup()`.
   */
  setup(): Promise<void>;
  /**
   * Atomically write a batch of records, treating each `(table, key)`
   * as the upsert identity. Returns the wire-format paths of every
   * record touched, in lex-sorted order.
   */
  upsertBatch(writes: WriteRequest[]): Promise<WriteResult>;
  /**
   * Delete a set of records by wire-format path. Returns which paths
   * were actually deleted vs already gone (§12).
   */
  deletePaths(paths: string[]): Promise<DeleteResult>;
  /**
   * Check whether `(table, key)` exists. Used for ref-existence
   * checks at write time on backends without DB-level FK (§7.1).
   * Default returns `false`.
   */
  recordExists(table: string, key: string): Promise<boolean>;
  /**
   * Find records in `table` whose `field` already has `value` and
   * whose key is NOT `excludingKey`. Used for declared UNIQUE
   * pre-check on backends without native enforcement (§13.4).
   */
  findUniqueConflicts(
    table: string,
    field: string,
    value: unknown,
    excludingKey: string,
  ): Promise<string[]>;
  /** Display name for telemetry (`"surrealdb"`, `"firestore"`). */
  name(): string;
}
