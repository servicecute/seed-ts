import {
  SeedError,
  type Lock,
  type LockClaim,
  type LockHolder,
  type LockVerb,
} from "@servicecute/seed-core";
import type { Surreal } from "surrealdb";

import { LOCK_DDL } from "./ddl.js";

/**
 * `Lock` against `__seeds_lock` (spec §10.5). T1.10 wired here:
 * `setup()` runs `LOCK_DDL` so `DbBackend.setup()` provisions the
 * lock table before the first `acquire()`. Verbs (T1.5–T1.9) are
 * still stubs and land next.
 */
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

  acquire(_verb: LockVerb, _holder: LockHolder, _ttlMs: number): Promise<LockClaim> {
    throw SeedError.coded(
      "E_INTERNAL",
      "SurrealLock.acquire not yet implemented (T1.5)",
    );
  }
  heartbeat(_claim: LockClaim): Promise<void> {
    throw SeedError.coded(
      "E_INTERNAL",
      "SurrealLock.heartbeat not yet implemented (T1.6)",
    );
  }
  release(_claim: LockClaim): Promise<void> {
    throw SeedError.coded(
      "E_INTERNAL",
      "SurrealLock.release not yet implemented (T1.7)",
    );
  }
  current(_verb: LockVerb): Promise<LockClaim | undefined> {
    throw SeedError.coded(
      "E_INTERNAL",
      "SurrealLock.current not yet implemented (T1.8)",
    );
  }
  forceUnlock(_verb: LockVerb): Promise<void> {
    throw SeedError.coded(
      "E_INTERNAL",
      "SurrealLock.forceUnlock not yet implemented (T1.9)",
    );
  }
}
