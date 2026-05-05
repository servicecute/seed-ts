import { SeedError } from "./error.js";
import type { Lock } from "./lock.js";
import type { Tracking } from "./tracking.js";

// Re-exported from this module so consumers can `import { ScopedBackends }
// from "@servicecute/seed-core"` after the spec §9.3 router pattern lands.

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
  /**
   * Spec §9.4 cross-check: what the backend believes is the current
   * scope identifier — active namespace for SurrealDB, project ID
   * for Firestore. The runner cross-checks this against the active
   * scope (configured `scopeTarget` or per-call override per §9.5)
   * at `setup()` and refuses to proceed on mismatch.
   *
   * Returns `undefined` when the backend cannot determine the scope
   * (test fixtures, in-memory mocks). When `undefined`, the
   * cross-check is skipped.
   */
  scopeTarget(): Promise<string | undefined>;
}

/**
 * Lazy backend factory used by [`ScopedBackends`] (spec §9.3).
 * Returns a Promise that resolves to a backend.
 */
export type BackendFactory<B extends DbBackend> = () => Promise<B>;

/**
 * Spec §9.3: registry of `name → factory` pairs. The runner picks
 * which backend to construct based on the active scope. Factories
 * are lazy — only invoked for scopes actually used in a run — and
 * cached per `ScopedBackends` instance.
 *
 * Names match the §4.1 registry pattern (`[a-z][a-z0-9_-]*`).
 * Registering "production" is forbidden — §7.3 calls production
 * data migration material; the runtime counterpart of that rule is
 * that production cannot be a registered scope.
 */
export class ScopedBackends<B extends DbBackend> {
  private readonly factories = new Map<string, BackendFactory<B>>();
  private readonly cache = new Map<string, B>();
  private readonly inflight = new Map<string, Promise<B>>();
  private static readonly NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

  /**
   * Register a factory for `scope`. Throws on duplicate names, names
   * that don't match the registry pattern, or the literal
   * `"production"`.
   */
  register(scope: string, factory: BackendFactory<B>): this {
    if (!ScopedBackends.NAME_PATTERN.test(scope)) {
      throw new SeedError(
        `scope name ${JSON.stringify(scope)} must match [a-z][a-z0-9_-]*`,
      );
    }
    if (scope === "production") {
      throw SeedError.coded(
        "E_SCOPE_VIOLATION",
        "scope 'production' MUST NOT be registered (§7.3)",
      );
    }
    if (this.factories.has(scope)) {
      throw new SeedError(
        `scope ${JSON.stringify(scope)} already has a registered factory`,
      );
    }
    this.factories.set(scope, factory);
    return this;
  }

  /** Lex-sorted list of registered scope names. */
  names(): string[] {
    return Array.from(this.factories.keys()).sort();
  }

  /** True when `scope` has a registered factory. */
  has(scope: string): boolean {
    return this.factories.has(scope);
  }

  /**
   * Resolve `scope` to a backend. Cached on first call. Subsequent
   * calls return the same backend instance. Concurrent resolves of
   * the same scope coalesce — only one factory invocation per scope
   * per process. Unregistered scope = `E_SCOPE_VIOLATION`.
   */
  async resolve(scope: string): Promise<B> {
    const cached = this.cache.get(scope);
    if (cached) return cached;

    const inflight = this.inflight.get(scope);
    if (inflight) return inflight;

    const factory = this.factories.get(scope);
    if (!factory) {
      throw SeedError.coded(
        "E_SCOPE_VIOLATION",
        `scope ${JSON.stringify(scope)} is not registered; available: [${this.names().join(", ")}]`,
      );
    }

    const promise = (async () => {
      try {
        const built = await factory();
        this.cache.set(scope, built);
        return built;
      } finally {
        this.inflight.delete(scope);
      }
    })();
    this.inflight.set(scope, promise);
    return promise;
  }
}
