import {
  SeedError,
  type TrackedIdentity,
  type Tracking,
  type TrackingEntry,
} from "@servicecute/seed-core";
import type { Firestore } from "firebase-admin/firestore";

import { SEEDS_COLLECTION } from "./index.js";

/**
 * Discriminator value tagging a doc in `__seeds` as a tracking entry
 * rather than a lock document. Spec §10.2 places lock docs at
 * `__seeds/_lock_*`, so they share the collection — the runner needs
 * a reliable way to filter list() results.
 */
export const KIND_FIELD = "_kind";
export const KIND_TRACKING = "tracking";
export const KIND_LOCK = "lock";

/**
 * Wire-format document stored in `__seeds/{name}`. Mirrors §10.2 +
 * the Rust adapter so cross-language parity tests see identical docs.
 * `appliedAt` round-trips as ms-since-epoch.
 */
interface SeedDoc {
  _kind: string;
  name: string;
  applied_at_ms: number;
  key_hash: string;
  scope: string[];
  paths_touched: string[];
  tracking_schema_version: string;
  spec_version: string;
  /** Auth-side identities the seed minted (proposed §25). Omitted
   * when empty — backwards-compat for docs written before §25. */
  created_identities?: TrackedIdentity[];
}

function toDoc(entry: TrackingEntry): SeedDoc {
  const out: SeedDoc = {
    _kind: KIND_TRACKING,
    name: entry.name,
    applied_at_ms: new Date(entry.appliedAt).getTime(),
    key_hash: entry.keyHash,
    scope: entry.scope,
    paths_touched: entry.pathsTouched,
    tracking_schema_version: entry.trackingSchemaVersion,
    spec_version: entry.specVersion,
  };
  if (entry.createdIdentities && entry.createdIdentities.length > 0) {
    out.created_identities = entry.createdIdentities;
  }
  return out;
}

function fromDoc(doc: Partial<SeedDoc>): TrackingEntry {
  const entry: TrackingEntry = {
    name: doc.name ?? "",
    keyHash: doc.key_hash ?? "",
    scope: Array.isArray(doc.scope) ? doc.scope : [],
    pathsTouched: Array.isArray(doc.paths_touched) ? doc.paths_touched : [],
    appliedAt: new Date(doc.applied_at_ms ?? 0).toISOString(),
    specVersion: doc.spec_version ?? "0.4.1",
    trackingSchemaVersion: doc.tracking_schema_version
      ? doc.tracking_schema_version
      : "1",
  };
  if (Array.isArray(doc.created_identities) && doc.created_identities.length > 0) {
    entry.createdIdentities = doc.created_identities;
  }
  return entry;
}

export class FirestoreTracking implements Tracking {
  constructor(private readonly db: Firestore) {}

  setup(): Promise<void> {
    // Firestore creates collections lazily — no schema-definition step.
    return Promise.resolve();
  }

  async upsert(entry: TrackingEntry): Promise<void> {
    try {
      await this.db
        .collection(SEEDS_COLLECTION)
        .doc(entry.name)
        .set(toDoc(entry));
    } catch (e) {
      throw SeedError.coded(
        "E_TRACKING_FAILED",
        `upsert __seeds doc for ${JSON.stringify(entry.name)}: ${(e as Error).message}`,
        e,
      );
    }
  }

  async get(name: string): Promise<TrackingEntry | undefined> {
    try {
      const snap = await this.db.collection(SEEDS_COLLECTION).doc(name).get();
      if (!snap.exists) return undefined;
      return fromDoc(snap.data() as Partial<SeedDoc>);
    } catch (e) {
      throw SeedError.coded(
        "E_TRACKING_FAILED",
        `read __seeds doc ${JSON.stringify(name)}: ${(e as Error).message}`,
        e,
      );
    }
  }

  async remove(name: string): Promise<void> {
    try {
      await this.db.collection(SEEDS_COLLECTION).doc(name).delete();
    } catch (e) {
      throw SeedError.coded(
        "E_TRACKING_FAILED",
        `delete __seeds doc ${JSON.stringify(name)}: ${(e as Error).message}`,
        e,
      );
    }
  }

  async list(): Promise<TrackingEntry[]> {
    try {
      // Filter server-side on the `_kind` discriminator so lock-shaped
      // docs (`_kind: "lock"`) never enter SeedDoc deserialization.
      const snap = await this.db
        .collection(SEEDS_COLLECTION)
        .where(KIND_FIELD, "==", KIND_TRACKING)
        .get();
      const out: TrackingEntry[] = [];
      snap.forEach((d) => {
        out.push(fromDoc(d.data() as Partial<SeedDoc>));
      });
      out.sort((a, b) => a.name.localeCompare(b.name));
      return out;
    } catch (e) {
      throw SeedError.coded(
        "E_TRACKING_FAILED",
        `list __seeds docs: ${(e as Error).message}`,
        e,
      );
    }
  }
}
