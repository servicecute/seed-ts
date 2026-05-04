import {
  SeedError,
  type Lock,
  type LockClaim,
  type LockHolder,
  type LockVerb,
} from "@servicecute/seed-core";

/**
 * `Lock` against `__seeds_lock` (spec §10.5). **Stub.** Bodies land
 * under T1.5–T1.9.
 */
export class SurrealLock implements Lock {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly db: unknown) {}

  setup(): Promise<void> {
    return Promise.resolve();
  }
  acquire(_verb: LockVerb, _holder: LockHolder, _ttlMs: number): Promise<LockClaim> {
    throw SeedError.coded("E_INTERNAL", "SurrealLock.acquire not yet implemented");
  }
  heartbeat(_claim: LockClaim): Promise<void> {
    throw SeedError.coded("E_INTERNAL", "SurrealLock.heartbeat not yet implemented");
  }
  release(_claim: LockClaim): Promise<void> {
    throw SeedError.coded("E_INTERNAL", "SurrealLock.release not yet implemented");
  }
  current(_verb: LockVerb): Promise<LockClaim | undefined> {
    throw SeedError.coded("E_INTERNAL", "SurrealLock.current not yet implemented");
  }
  forceUnlock(_verb: LockVerb): Promise<void> {
    throw SeedError.coded("E_INTERNAL", "SurrealLock.forceUnlock not yet implemented");
  }
}
