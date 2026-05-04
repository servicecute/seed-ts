import {
  type DbBackend,
  type DeleteResult,
  type Lock,
  SeedError,
  type Tracking,
  type WriteRequest,
  type WriteResult,
} from "@servicecute/seed-core";
import type { Surreal } from "surrealdb";

import { SurrealLock } from "./lock.js";
import { SurrealTracking } from "./tracking.js";

/**
 * SurrealDB adapter — wraps a connected `surrealdb` v2 client.
 *
 * Implements `DbBackend` from `@servicecute/seed-core`. Tracking is
 * complete (T1.1–T1.4); lock setup is wired (T1.10); lock verb
 * bodies (T1.5–T1.9) and `upsertBatch` / `deletePaths` (T1.11–T1.12)
 * land in subsequent batches.
 */
export class SurrealBackend implements DbBackend {
  private readonly db: Surreal;
  private readonly _tracking: SurrealTracking;
  private readonly _lock: SurrealLock;

  constructor(db: Surreal) {
    this.db = db;
    this._tracking = new SurrealTracking(db);
    this._lock = new SurrealLock(db);
  }

  tracking(): Tracking {
    return this._tracking;
  }

  lock(): Lock {
    return this._lock;
  }

  async setup(): Promise<void> {
    await this._tracking.setup();
    await this._lock.setup();
  }

  upsertBatch(_writes: WriteRequest[]): Promise<WriteResult> {
    throw SeedError.coded(
      "E_INTERNAL",
      "SurrealBackend.upsertBatch not yet implemented (T1.11)",
    );
  }

  deletePaths(_paths: string[]): Promise<DeleteResult> {
    throw SeedError.coded(
      "E_INTERNAL",
      "SurrealBackend.deletePaths not yet implemented (T1.12)",
    );
  }

  recordExists(_table: string, _key: string): Promise<boolean> {
    throw SeedError.coded(
      "E_INTERNAL",
      "SurrealBackend.recordExists not yet implemented (T4.7-equivalent)",
    );
  }

  findUniqueConflicts(
    _table: string,
    _field: string,
    _value: unknown,
    _excludingKey: string,
  ): Promise<string[]> {
    throw SeedError.coded(
      "E_INTERNAL",
      "SurrealBackend.findUniqueConflicts not yet implemented (T4.8-equivalent)",
    );
  }

  name(): string {
    return "surrealdb";
  }
}
