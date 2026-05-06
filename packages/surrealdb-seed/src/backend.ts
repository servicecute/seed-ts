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
 * Best-effort detection of a referential-integrity rejection from
 * SurrealDB's `REFERENCE` enforcement (spec §13.3). The driver does
 * not surface a stable error variant, so we pattern-match on the
 * message. False negatives degrade to `E_INTERNAL`, which is
 * acceptable — the spec only mandates the code, not the detection
 * strategy.
 */
function isFkViolation(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("reference") || m.includes("foreign key") || m.includes("still in use");
}

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

  async upsertBatch(writes: WriteRequest[]): Promise<WriteResult> {
    if (writes.length === 0) {
      return { pathsTouched: [], recordCount: 0 };
    }

    // Build a transactional script with N parameterised UPSERTs. Using
    // `type::record($t, $k)` avoids quoting concerns for keys that
    // contain hyphens (per §6.2 grammar).
    const lines: string[] = ["BEGIN TRANSACTION;"];
    const bindings: Record<string, unknown> = {};
    for (let i = 0; i < writes.length; i++) {
      const w = writes[i]!;
      lines.push(`UPSERT type::record($t${i}, $k${i}) CONTENT $d${i};`);
      bindings[`t${i}`] = w.table;
      bindings[`k${i}`] = w.key;
      bindings[`d${i}`] = w.data;
    }
    lines.push("COMMIT TRANSACTION;");

    try {
      await this.db.query(lines.join("\n"), bindings);
    } catch (e) {
      throw SeedError.coded(
        "E_INTERNAL",
        `upsert_batch transaction: ${(e as Error).message}`,
        e,
      );
    }

    // Per T9.1 the runner enforces lex-ordering on `paths_touched`
    // before persisting tracking; the adapter just reports what was
    // written, in input order.
    return {
      pathsTouched: writes.map((w) => `${w.table}:${w.key}`),
      recordCount: writes.length,
    };
  }

  async deletePaths(paths: string[]): Promise<DeleteResult> {
    // Spec §12: missing records are non-fatal — the desired end state
    // (record gone) is satisfied. The DELETE statement returns the
    // affected rows; an empty result means the record was already
    // gone, which we report back to the runner as a `missing` path so
    // it can emit `seed.reset.path_missing`.
    //
    // Spec §13.3: surface DB-level referential rejections verbatim
    // with `E_RESET_FK_HELD`.
    const deleted: string[] = [];
    const missing: string[] = [];

    for (const path of paths) {
      const split = path.indexOf(":");
      if (split <= 0) {
        throw SeedError.coded(
          "E_INTERNAL",
          `invalid path format (expected 'table:key'): ${path}`,
        );
      }
      const table = path.slice(0, split);
      const key = path.slice(split + 1);

      let removed: unknown[] = [];
      try {
        const result = await this.db.query<[unknown[]]>(
          `DELETE type::record($t, $k) RETURN BEFORE`,
          { t: table, k: key },
        );
        removed = result[0] ?? [];
      } catch (e) {
        const msg = (e as Error).message;
        const code = isFkViolation(msg) ? "E_RESET_FK_HELD" : "E_INTERNAL";
        throw SeedError.coded(code, `delete failed for ${path}: ${msg}`, e);
      }

      if (removed.length === 0) {
        missing.push(path);
      } else {
        deleted.push(path);
      }
    }

    return { deleted, missing };
  }

  async recordExists(table: string, key: string): Promise<boolean> {
    try {
      const result = await this.db.query<[unknown[]]>(
        `SELECT id FROM type::record($t, $k)`,
        { t: table, k: key },
      );
      return (result[0] ?? []).length > 0;
    } catch (e) {
      throw SeedError.coded(
        "E_INTERNAL",
        `record_exists query for ${table}:${key}: ${(e as Error).message}`,
        e,
      );
    }
  }

  async findKeyByField(
    table: string,
    field: string,
    value: unknown,
  ): Promise<string | undefined> {
    // Same identifier-safety rule as findUniqueConflicts — field
    // names are spliced into the SELECT, so reject anything that
    // isn't a plain identifier.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
      throw SeedError.coded(
        "E_INTERNAL",
        `findKeyByField: refusing to splice non-identifier field name ${JSON.stringify(field)}`,
      );
    }
    type Row = { id: string };
    try {
      const result = await this.db.query<[Row[]]>(
        `SELECT meta::id(id) AS id FROM type::table($t) WHERE ${field} = $v LIMIT 1`,
        { t: table, v: value },
      );
      const rows = result[0] ?? [];
      return rows[0]?.id;
    } catch (e) {
      throw SeedError.coded(
        "E_INTERNAL",
        `findKeyByField query on ${table}.${field}: ${(e as Error).message}`,
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
    // For SurrealDB SCHEMAFULL with a UNIQUE index this duplicates
    // DB-side enforcement, but it's cheap and lets us emit
    // `E_CONSTRAINT_UNIQUE` before the upsert lands rather than
    // after. The runner uses it on every backend (§13.4).
    //
    // Field name comes from declared `ConstraintHints.unique`; we
    // splice it directly into the SELECT (parameterising field names
    // would require dynamic SQL anyway). Field names are validated by
    // the registry pattern's `[a-z][a-z0-9_-]*` rule and so are
    // injection-safe.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field)) {
      throw SeedError.coded(
        "E_INTERNAL",
        `findUniqueConflicts: refusing to splice non-identifier field name ${JSON.stringify(field)}`,
      );
    }
    type Row = { id: string };
    try {
      const result = await this.db.query<[Row[]]>(
        `SELECT meta::id(id) AS id FROM type::table($t) WHERE ${field} = $v`,
        { t: table, v: value },
      );
      const rows = result[0] ?? [];
      return rows.filter((r) => r.id !== excludingKey).map((r) => r.id);
    } catch (e) {
      throw SeedError.coded(
        "E_INTERNAL",
        `findUniqueConflicts query on ${table}.${field}: ${(e as Error).message}`,
        e,
      );
    }
  }

  async scopeTarget(): Promise<string | undefined> {
    // Spec §9.4: read the active namespace from the session.
    // Returns `undefined` for empty/unset namespaces so the runner's
    // cross-check skips and trusts the consumer.
    try {
      const result = await this.db.query<[string | null | undefined]>(
        `RETURN session::ns()`,
      );
      const ns = result[0];
      return typeof ns === "string" && ns !== "" ? ns : undefined;
    } catch (e) {
      throw SeedError.coded(
        "E_INTERNAL",
        `scopeTarget: query session::ns(): ${(e as Error).message}`,
        e,
      );
    }
  }

  name(): string {
    return "surrealdb";
  }
}
