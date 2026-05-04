import {
  SeedError,
  type Lock,
  type LockClaim,
  type LockHolder,
  type LockVerb,
} from "@servicecute/seed-core";

/**
 * `Lock` against `__seeds/_lock_apply` and `__seeds/_lock_regenerate`
 * (spec §10.2 / §10.5). **Stub.** Bodies land under T4.3–T4.4.
 */
export class FirestoreLock implements Lock {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly db: unknown) {}

  setup(): Promise<void> {
    return Promise.resolve();
  }
  acquire(_verb: LockVerb, _holder: LockHolder, _ttlMs: number): Promise<LockClaim> {
    throw SeedError.coded("E_INTERNAL", "FirestoreLock.acquire not yet implemented");
  }
  heartbeat(_claim: LockClaim): Promise<void> {
    throw SeedError.coded("E_INTERNAL", "FirestoreLock.heartbeat not yet implemented");
  }
  release(_claim: LockClaim): Promise<void> {
    throw SeedError.coded("E_INTERNAL", "FirestoreLock.release not yet implemented");
  }
  current(_verb: LockVerb): Promise<LockClaim | undefined> {
    throw SeedError.coded("E_INTERNAL", "FirestoreLock.current not yet implemented");
  }
  forceUnlock(_verb: LockVerb): Promise<void> {
    throw SeedError.coded("E_INTERNAL", "FirestoreLock.forceUnlock not yet implemented");
  }
}
