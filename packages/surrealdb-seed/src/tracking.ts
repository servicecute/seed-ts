import {
  SeedError,
  type TrackedIdentity,
  type Tracking,
  type TrackingEntry,
} from "@servicecute/seed-core";
import type { Surreal } from "surrealdb";

import { TRACKING_DDL } from "./ddl.js";

const SEEDS_TABLE = "__seeds";

/**
 * Wire-format row stored in `__seeds`. Mirrors `TrackingEntry` but
 * uses `Date` for `applied_at` so the SurrealDB client maps it to the
 * native `datetime` column. `tracking_schema_version` defaults to
 * `"1"` on read for older docs that pre-date the field (§10.1).
 */
interface SeedRow {
  name: string;
  applied_at: Date;
  key_hash: string;
  scope: string[];
  paths_touched: string[];
  tracking_schema_version: string;
  spec_version: string;
  /** Auth-side identities the seed minted (proposed §25). Stored as
   * a typed array; the SurrealDB schema is SCHEMALESS for this row
   * so older rows that pre-date the field deserialise with this as
   * `undefined`. */
  created_identities?: TrackedIdentity[];
}

function toRow(entry: TrackingEntry): SeedRow {
  // Runner sorts paths_touched before calling upsert (T9.1).
  const row: SeedRow = {
    name: entry.name,
    applied_at: new Date(entry.appliedAt),
    key_hash: entry.keyHash,
    scope: entry.scope,
    paths_touched: entry.pathsTouched,
    tracking_schema_version: entry.trackingSchemaVersion,
    spec_version: entry.specVersion,
  };
  if (entry.createdIdentities && entry.createdIdentities.length > 0) {
    row.created_identities = entry.createdIdentities;
  }
  return row;
}

function fromRow(row: SeedRow): TrackingEntry {
  const appliedAt =
    row.applied_at instanceof Date
      ? row.applied_at.toISOString()
      : new Date(row.applied_at as unknown as string).toISOString();
  const entry: TrackingEntry = {
    name: row.name,
    keyHash: row.key_hash,
    scope: Array.isArray(row.scope) ? row.scope : [],
    pathsTouched: Array.isArray(row.paths_touched) ? row.paths_touched : [],
    appliedAt,
    specVersion: row.spec_version,
    trackingSchemaVersion: row.tracking_schema_version
      ? row.tracking_schema_version
      : "1",
  };
  if (Array.isArray(row.created_identities) && row.created_identities.length > 0) {
    entry.createdIdentities = row.created_identities;
  }
  return entry;
}

export class SurrealTracking implements Tracking {
  constructor(private readonly db: Surreal) {}

  async setup(): Promise<void> {
    try {
      await this.db.query(TRACKING_DDL);
    } catch (e) {
      throw SeedError.coded(
        "E_TRACKING_FAILED",
        `setup __seeds table: ${(e as Error).message}`,
        e,
      );
    }
  }

  async upsert(entry: TrackingEntry): Promise<void> {
    const row = toRow(entry);
    try {
      await this.db.query(
        `UPSERT type::record($t, $k) CONTENT $row`,
        { t: SEEDS_TABLE, k: entry.name, row },
      );
    } catch (e) {
      throw SeedError.coded(
        "E_TRACKING_FAILED",
        `upsert __seeds row for ${JSON.stringify(entry.name)}: ${(e as Error).message}`,
        e,
      );
    }
  }

  async get(name: string): Promise<TrackingEntry | undefined> {
    try {
      const result = await this.db.query<[SeedRow[]]>(
        `SELECT * FROM type::record($t, $k)`,
        { t: SEEDS_TABLE, k: name },
      );
      const rows = result[0] ?? [];
      const row = rows[0];
      return row ? fromRow(row) : undefined;
    } catch (e) {
      throw SeedError.coded(
        "E_TRACKING_FAILED",
        `select __seeds row ${JSON.stringify(name)}: ${(e as Error).message}`,
        e,
      );
    }
  }

  async remove(name: string): Promise<void> {
    try {
      await this.db.query(
        `DELETE type::record($t, $k)`,
        { t: SEEDS_TABLE, k: name },
      );
    } catch (e) {
      throw SeedError.coded(
        "E_TRACKING_FAILED",
        `delete __seeds row ${JSON.stringify(name)}: ${(e as Error).message}`,
        e,
      );
    }
  }

  async list(): Promise<TrackingEntry[]> {
    try {
      const result = await this.db.query<[SeedRow[]]>(
        `SELECT * FROM ${SEEDS_TABLE} ORDER BY name`,
      );
      const rows = result[0] ?? [];
      return rows.map(fromRow);
    } catch (e) {
      throw SeedError.coded(
        "E_TRACKING_FAILED",
        `list __seeds rows: ${(e as Error).message}`,
        e,
      );
    }
  }
}
