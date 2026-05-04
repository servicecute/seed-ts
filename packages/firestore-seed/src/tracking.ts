import {
  SeedError,
  type Tracking,
  type TrackingEntry,
} from "@servicecute/seed-core";

/**
 * `Tracking` against the `__seeds` collection (spec §10.2). **Stub.**
 * Bodies land under T4.1–T4.2.
 */
export class FirestoreTracking implements Tracking {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly db: unknown) {}

  setup(): Promise<void> {
    // Firestore creates collections lazily — this is a true no-op.
    return Promise.resolve();
  }
  upsert(_entry: TrackingEntry): Promise<void> {
    throw SeedError.coded(
      "E_INTERNAL",
      "FirestoreTracking.upsert not yet implemented (T4.1)",
    );
  }
  get(_name: string): Promise<TrackingEntry | undefined> {
    throw SeedError.coded(
      "E_INTERNAL",
      "FirestoreTracking.get not yet implemented (T4.2)",
    );
  }
  remove(_name: string): Promise<void> {
    throw SeedError.coded(
      "E_INTERNAL",
      "FirestoreTracking.remove not yet implemented (T4.2)",
    );
  }
  list(): Promise<TrackingEntry[]> {
    throw SeedError.coded(
      "E_INTERNAL",
      "FirestoreTracking.list not yet implemented (T4.2)",
    );
  }
}
