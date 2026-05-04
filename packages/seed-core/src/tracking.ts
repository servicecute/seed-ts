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
