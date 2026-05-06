/** Tracking entry per spec §10. */
export interface TrackingEntry {
  name: string;
  keyHash: string;
  scope: string[];
  pathsTouched: string[];
  /** ISO 8601 with millisecond precision, UTC. */
  appliedAt: string;
  specVersion: string;
  trackingSchemaVersion: string;
  /**
   * Auth-side identities the runner minted for this seed (proposed
   * spec §25). Reset uses this to tear identities down after the
   * data is gone. Empty/omitted for seeds that don't touch auth and
   * for tracking rows written by older runners that didn't know
   * about §25.
   */
  createdIdentities?: import("./identity.js").TrackedIdentity[];
}

/**
 * Backend-agnostic tracking interface. Implementations live in adapter
 * packages; the runner only sees this surface (§10).
 */
export interface Tracking {
  /** Idempotently ensure the tracking storage exists. */
  setup(): Promise<void>;
  /** Insert or update a tracking entry. */
  upsert(entry: TrackingEntry): Promise<void>;
  /** Look up an entry by seed name. */
  get(name: string): Promise<TrackingEntry | undefined>;
  /** Remove an entry. Used by `reset --sudo`. */
  remove(name: string): Promise<void>;
  /** List all tracking entries, lex-sorted by name. */
  list(): Promise<TrackingEntry[]>;
}
