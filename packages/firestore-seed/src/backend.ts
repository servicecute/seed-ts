import {
  type DbBackend,
  type DeleteResult,
  type Lock,
  SeedError,
  type Tracking,
  type WriteRequest,
  type WriteResult,
} from "@servicecute/seed-core";

import { FirestoreLock } from "./lock.js";
import { FirestoreTracking } from "./tracking.js";

/**
 * Firestore adapter — wraps `firebase-admin`'s `Firestore` instance.
 *
 * **Stub.** Bodies will land under T4.x in seed-ts/tasks.md.
 */
export class FirestoreBackend implements DbBackend {
  private readonly db: unknown;
  private readonly _tracking: FirestoreTracking;
  private readonly _lock: FirestoreLock;

  constructor(db: unknown) {
    this.db = db;
    this._tracking = new FirestoreTracking(db);
    this._lock = new FirestoreLock(db);
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
      "FirestoreBackend.upsertBatch not yet implemented (T4.5)",
    );
  }

  deletePaths(_paths: string[]): Promise<DeleteResult> {
    throw SeedError.coded(
      "E_INTERNAL",
      "FirestoreBackend.deletePaths not yet implemented (T4.6)",
    );
  }

  recordExists(_table: string, _key: string): Promise<boolean> {
    throw SeedError.coded(
      "E_INTERNAL",
      "FirestoreBackend.recordExists not yet implemented",
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
      "FirestoreBackend.findUniqueConflicts not yet implemented",
    );
  }

  name(): string {
    return "firestore";
  }
}
