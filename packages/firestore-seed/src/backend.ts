import {
  type DbBackend,
  type DeleteResult,
  type Lock,
  SeedError,
  type Tracking,
  type WriteRequest,
  type WriteResult,
} from "@servicecute/seed-core";
import type { Firestore } from "firebase-admin/firestore";

import { FirestoreLock } from "./lock.js";
import { FirestoreTracking } from "./tracking.js";

/**
 * Firestore caps each batched write / transaction at 500 ops. Per-chunk
 * atomicity, cross-chunk best-effort rollback (§8.3).
 */
const FIRESTORE_BATCH_LIMIT = 500;

/** Firestore adapter — wraps a `firebase-admin` Firestore instance. */
export class FirestoreBackend implements DbBackend {
  private readonly db: Firestore;
  private readonly _tracking: FirestoreTracking;
  private readonly _lock: FirestoreLock;

  constructor(db: Firestore) {
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

  async upsertBatch(writes: WriteRequest[]): Promise<WriteResult> {
    if (writes.length === 0) {
      return { pathsTouched: [], recordCount: 0 };
    }

    // §8.3: each chunk is one transaction; cross-chunk failures
    // trigger reverse delete of already-committed records.
    const allPaths: string[] = [];
    const committed: Array<{ collection: string; docId: string }> = [];

    for (let i = 0; i < writes.length; i += FIRESTORE_BATCH_LIMIT) {
      const chunk = writes.slice(i, i + FIRESTORE_BATCH_LIMIT);
      try {
        await this.db.runTransaction(async (tx) => {
          for (const w of chunk) {
            const ref = this.db.collection(w.table).doc(w.key);
            tx.set(ref, w.data as Record<string, unknown>);
          }
        });
      } catch (e) {
        await this.rollback(committed);
        throw SeedError.coded(
          "E_INTERNAL",
          `upsertBatch chunk failed; rolled back: ${(e as Error).message}`,
          e,
        );
      }
      for (const w of chunk) {
        committed.push({ collection: w.table, docId: w.key });
        allPaths.push(`${w.table}/${w.key}`);
      }
    }

    return { pathsTouched: allPaths, recordCount: writes.length };
  }

  async deletePaths(paths: string[]): Promise<DeleteResult> {
    // Spec §18.2 forbids recursive-delete utilities — only the
    // explicit tracked paths. Per §12, missing records are
    // non-fatal: pre-read so the runner can emit
    // `seed.reset.path_missing`.
    const deleted: string[] = [];
    const missing: string[] = [];

    for (const path of paths) {
      const split = path.lastIndexOf("/");
      if (split <= 0) {
        throw SeedError.coded(
          "E_INTERNAL",
          `invalid Firestore path (expected 'collection/doc-id'): ${path}`,
        );
      }
      const collection = path.slice(0, split);
      const docId = path.slice(split + 1);
      const ref = this.db.collection(collection).doc(docId);

      const snap = await ref.get();
      if (!snap.exists) {
        missing.push(path);
        continue;
      }
      try {
        await ref.delete();
        deleted.push(path);
      } catch (e) {
        throw SeedError.coded(
          "E_INTERNAL",
          `delete failed for ${path}: ${(e as Error).message}`,
          e,
        );
      }
    }

    return { deleted, missing };
  }

  async recordExists(table: string, key: string): Promise<boolean> {
    try {
      const snap = await this.db.collection(table).doc(key).get();
      return snap.exists;
    } catch (e) {
      throw SeedError.coded(
        "E_INTERNAL",
        `recordExists for ${table}/${key}: ${(e as Error).message}`,
        e,
      );
    }
  }

  async findUniqueConflicts(
    table: string,
    field: string,
    value: unknown,
    excludingKey: string,
  ): Promise<string[]> {
    // Firestore queries return doc bodies, not IDs by default; we use
    // `forEach` on the snapshot to inspect each doc's id. We bound
    // the query at 50 — the spec calls UNIQUE pre-checks advisory
    // (§13.4), surfacing the first few duplicates is enough.
    try {
      const snap = await this.db
        .collection(table)
        .where(field, "==", value as never)
        .limit(50)
        .get();
      const conflicts: string[] = [];
      snap.forEach((d) => {
        if (d.id !== excludingKey) conflicts.push(d.id);
      });
      return conflicts;
    } catch (e) {
      throw SeedError.coded(
        "E_INTERNAL",
        `findUniqueConflicts query for ${table}/${field}: ${(e as Error).message}`,
        e,
      );
    }
  }

  /**
   * Best-effort rollback when a batched-write chunk fails after
   * earlier chunks committed (§8.3). Errors are swallowed — the
   * caller already has the original error.
   */
  private async rollback(
    paths: Array<{ collection: string; docId: string }>,
  ): Promise<void> {
    for (const { collection, docId } of paths) {
      try {
        await this.db.collection(collection).doc(docId).delete();
      } catch (_e) {
        // best-effort
      }
    }
  }

  async scopeTarget(): Promise<string | undefined> {
    // Spec §9.4: the project ID was passed at FirestoreDb
    // construction. firebase-admin's Firestore.options() returns
    // a Settings-like object containing the projectId.
    const opts = (this.db as unknown as { options?: () => unknown }).options?.();
    if (
      typeof opts === "object" &&
      opts !== null &&
      "projectId" in (opts as Record<string, unknown>)
    ) {
      const id = (opts as Record<string, unknown>)["projectId"];
      if (typeof id === "string" && id !== "") return id;
    }
    // Fall back to the app's projectId on the FirestoreDb's parent
    // app — firebase-admin always exposes it.
    const app = (this.db as unknown as { app?: { options?: { projectId?: string } } })
      .app;
    if (app?.options?.projectId) return app.options.projectId;
    return undefined;
  }

  name(): string {
    return "firestore";
  }
}
