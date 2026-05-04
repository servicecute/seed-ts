import {
  SeedError,
  type Lock,
  type LockClaim,
  type LockHolder,
  type LockVerb,
} from "@servicecute/seed-core";
import type { Surreal } from "surrealdb";

import { LOCK_DDL } from "./ddl.js";

const LOCK_TABLE = "__seeds_lock";

/**
 * Wire-format row stored in `__seeds_lock`. `holder` is JSON-encoded
 * because the DDL's `holder TYPE string` cannot hold a structured
 * value. Mirrors the shape used by the Rust adapter so the parity
 * tests see identical rows.
 */
interface LockRow {
  verb: string;
  holder: string;
  acquired_at: Date;
  expires_at: Date;
  ttl_secs: number;
}

function holderToJson(h: LockHolder): string {
  return JSON.stringify({ host: h.host, pid: h.pid, label: h.label });
}

function holderFromJson(json: string): LockHolder {
  try {
    const obj = JSON.parse(json) as Partial<LockHolder>;
    return {
      host: typeof obj.host === "string" ? obj.host : "unknown",
      pid: typeof obj.pid === "number" ? obj.pid : 0,
      label: typeof obj.label === "string" ? obj.label : "",
    };
  } catch {
    return { host: "unknown", pid: 0, label: json };
  }
}

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") return new Date(value);
  throw SeedError.coded(
    "E_INTERNAL",
    `lock row datetime field is neither Date nor string-coercible: ${typeof value}`,
  );
}

function rowToClaim(row: LockRow): LockClaim {
  if (row.verb !== "apply" && row.verb !== "regenerate") {
    throw SeedError.coded(
      "E_INTERNAL",
      `unknown lock verb in storage: ${JSON.stringify(row.verb)}`,
    );
  }
  const acquiredAt = asDate(row.acquired_at);
  const expiresAt = asDate(row.expires_at);
  const ttlMs = Math.max(0, row.ttl_secs) * 1000;
  const heartbeatAt = new Date(expiresAt.getTime() - ttlMs);
  return {
    verb: row.verb,
    holder: holderFromJson(row.holder),
    claimedAt: acquiredAt.toISOString(),
    heartbeatAt: heartbeatAt.toISOString(),
    ttlMs,
  };
}

function isHeldAt(row: LockRow, now: Date): boolean {
  return asDate(row.expires_at).getTime() > now.getTime();
}

export class SurrealLock implements Lock {
  constructor(private readonly db: Surreal) {}

  async setup(): Promise<void> {
    try {
      await this.db.query(LOCK_DDL);
    } catch (e) {
      throw SeedError.coded(
        "E_INTERNAL",
        `setup __seeds_lock table: ${(e as Error).message}`,
        e,
      );
    }
  }

  async acquire(
    verb: LockVerb,
    holder: LockHolder,
    ttlMs: number,
  ): Promise<LockClaim> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const holderJson = holderToJson(holder);

    // Read current state.
    const existing = await this.readRow(verb);
    if (existing && isHeldAt(existing, now)) {
      const other = rowToClaim(existing);
      throw SeedError.coded(
        "E_RUNNER_LOCKED",
        `lock for ${verb} held by host=${other.holder.host}, pid=${other.holder.pid}, label=${JSON.stringify(other.holder.label)}; expires ${asDate(existing.expires_at).toISOString()}`,
      );
    }
    // Either absent or expired — fall through and overwrite. Steal-on-
    // expired is implicit (T8.2).

    // Write our claim. UPSERT replaces an expired row in place or
    // inserts a new one keyed by verb.
    const row: LockRow = {
      verb,
      holder: holderJson,
      acquired_at: now,
      expires_at: expiresAt,
      ttl_secs: Math.floor(ttlMs / 1000),
    };
    try {
      await this.db.query(
        `UPSERT type::record($t, $k) CONTENT $row`,
        { t: LOCK_TABLE, k: verb, row },
      );
    } catch (e) {
      throw SeedError.coded(
        "E_INTERNAL",
        `write __seeds_lock claim: ${(e as Error).message}`,
        e,
      );
    }

    // Re-read and verify our claim landed (closes the read-write race
    // window between two concurrent acquires).
    const written = await this.readRow(verb);
    if (!written) {
      throw SeedError.coded(
        "E_INTERNAL",
        `lock ${verb} disappeared after write`,
      );
    }
    if (written.holder !== holderJson) {
      const other = rowToClaim(written);
      throw SeedError.coded(
        "E_RUNNER_LOCKED",
        `lost race acquiring ${verb}: held by host=${other.holder.host}, pid=${other.holder.pid}, label=${JSON.stringify(other.holder.label)}`,
      );
    }
    return {
      verb,
      holder,
      claimedAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      ttlMs,
    };
  }

  async heartbeat(claim: LockClaim): Promise<void> {
    const newExpiry = new Date(Date.now() + claim.ttlMs);
    const holderJson = holderToJson(claim.holder);
    try {
      await this.db.query(
        `UPDATE type::record($t, $k) SET expires_at = $expires WHERE holder = $h`,
        { t: LOCK_TABLE, k: claim.verb, expires: newExpiry, h: holderJson },
      );
    } catch (e) {
      throw SeedError.coded(
        "E_INTERNAL",
        `heartbeat __seeds_lock: ${(e as Error).message}`,
        e,
      );
    }
  }

  async release(claim: LockClaim): Promise<void> {
    const holderJson = holderToJson(claim.holder);
    try {
      // Idempotent: only delete if we still own the row. Force-unlocked
      // locks turn this into a no-op — release MUST NOT error.
      await this.db.query(
        `DELETE type::record($t, $k) WHERE holder = $h`,
        { t: LOCK_TABLE, k: claim.verb, h: holderJson },
      );
    } catch (e) {
      throw SeedError.coded(
        "E_INTERNAL",
        `release __seeds_lock: ${(e as Error).message}`,
        e,
      );
    }
  }

  async current(verb: LockVerb): Promise<LockClaim | undefined> {
    const row = await this.readRow(verb);
    return row ? rowToClaim(row) : undefined;
  }

  async forceUnlock(verb: LockVerb): Promise<void> {
    try {
      await this.db.query(
        `DELETE type::record($t, $k)`,
        { t: LOCK_TABLE, k: verb },
      );
    } catch (e) {
      throw SeedError.coded(
        "E_INTERNAL",
        `force-unlock __seeds_lock: ${(e as Error).message}`,
        e,
      );
    }
  }

  private async readRow(verb: LockVerb): Promise<LockRow | undefined> {
    try {
      const result = await this.db.query<[LockRow[]]>(
        `SELECT * FROM type::record($t, $k)`,
        { t: LOCK_TABLE, k: verb },
      );
      const rows = result[0] ?? [];
      return rows[0];
    } catch (e) {
      throw SeedError.coded(
        "E_INTERNAL",
        `read __seeds_lock for ${verb}: ${(e as Error).message}`,
        e,
      );
    }
  }
}
