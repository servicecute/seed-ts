import {
  SeedError,
  type Tracking,
  type TrackingEntry,
} from "@servicecute/seed-core";

/**
 * `Tracking` against `__seeds` (spec §10.1). **Stub.** Bodies land
 * under T1.1–T1.4.
 */
export class SurrealTracking implements Tracking {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly db: unknown) {}

  setup(): Promise<void> {
    throw SeedError.coded(
      "E_INTERNAL",
      "SurrealTracking.setup not yet implemented (T1.x)",
    );
  }
  upsert(_entry: TrackingEntry): Promise<void> {
    throw SeedError.coded("E_INTERNAL", "SurrealTracking.upsert not yet implemented");
  }
  get(_name: string): Promise<TrackingEntry | undefined> {
    throw SeedError.coded("E_INTERNAL", "SurrealTracking.get not yet implemented");
  }
  remove(_name: string): Promise<void> {
    throw SeedError.coded("E_INTERNAL", "SurrealTracking.remove not yet implemented");
  }
  list(): Promise<TrackingEntry[]> {
    throw SeedError.coded("E_INTERNAL", "SurrealTracking.list not yet implemented");
  }
}
