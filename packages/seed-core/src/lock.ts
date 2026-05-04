/** Spec §8.4 / §10.5 advisory lock. */

export type LockVerb = "apply" | "regenerate";

export interface LockHolder {
  host: string;
  pid: number;
  label: string;
}

export interface LockClaim {
  verb: LockVerb;
  holder: LockHolder;
  /** ISO 8601 / RFC 3339, UTC. */
  claimedAt: string;
  heartbeatAt: string;
  /** Time-to-live in milliseconds. */
  ttlMs: number;
}

/**
 * Backend-agnostic lock interface. Implementations live in adapter
 * packages; the runner only sees this surface (§10.5).
 */
export interface Lock {
  /** Idempotently ensure the lock storage exists. Default no-op. */
  setup(): Promise<void>;
  /** Try to acquire `verb`. On contention → throws `E_RUNNER_LOCKED`. */
  acquire(verb: LockVerb, holder: LockHolder, ttlMs: number): Promise<LockClaim>;
  /** Refresh `expires_at`. Idempotent. */
  heartbeat(claim: LockClaim): Promise<void>;
  /** Release. Idempotent (force-unlocked locks must not error out). */
  release(claim: LockClaim): Promise<void>;
  /** Read-only lookup for `seed status` / contention messages. */
  current(verb: LockVerb): Promise<LockClaim | undefined>;
  /** Forcibly clear the slot regardless of holder identity. */
  forceUnlock(verb: LockVerb): Promise<void>;
}
