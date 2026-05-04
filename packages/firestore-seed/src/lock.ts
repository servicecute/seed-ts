import {
  SeedError,
  type Lock,
  type LockClaim,
  type LockHolder,
  type LockVerb,
} from "@servicecute/seed-core";
import type { Firestore, Timestamp } from "firebase-admin/firestore";

import { APPLY_LOCK_DOC, REGENERATE_LOCK_DOC, SEEDS_COLLECTION } from "./index.js";
import { KIND_FIELD, KIND_LOCK } from "./tracking.js";

/**
 * Document stored at `__seeds/_lock_*`. Mirrors the Rust adapter at
 * the field level so cross-language parity tests see identical
 * documents. `holder` round-trips through a typed sub-object rather
 * than the JSON-string trick the Surreal adapter uses (Firestore can
 * store nested objects natively).
 */
interface LockDoc {
  _kind: string;
  verb: string;
  holder: { host: string; pid: number; label: string };
  acquired_at_ms: number;
  expires_at_ms: number;
  ttl_ms: number;
}

function docId(verb: LockVerb): string {
  return verb === "apply" ? APPLY_LOCK_DOC : REGENERATE_LOCK_DOC;
}

function asNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  // Firestore Timestamp has toMillis(); fall back via instanceof check
  if (v && typeof v === "object" && "toMillis" in v) {
    return (v as Timestamp).toMillis();
  }
  return 0;
}

function docToClaim(doc: Partial<LockDoc>): LockClaim {
  if (doc.verb !== "apply" && doc.verb !== "regenerate") {
    throw SeedError.coded(
      "E_INTERNAL",
      `unknown lock verb in storage: ${JSON.stringify(doc.verb)}`,
    );
  }
  const acquiredAt = asNumber(doc.acquired_at_ms);
  const expiresAt = asNumber(doc.expires_at_ms);
  const ttlMs = asNumber(doc.ttl_ms);
  const heartbeatAt = expiresAt - ttlMs;
  return {
    verb: doc.verb,
    holder: {
      host: doc.holder?.host ?? "unknown",
      pid: doc.holder?.pid ?? 0,
      label: doc.holder?.label ?? "",
    },
    claimedAt: new Date(acquiredAt).toISOString(),
    heartbeatAt: new Date(heartbeatAt).toISOString(),
    ttlMs,
  };
}

function isHeldAt(doc: Partial<LockDoc>, nowMs: number): boolean {
  return asNumber(doc.expires_at_ms) > nowMs;
}

export class FirestoreLock implements Lock {
  constructor(private readonly db: Firestore) {}

  setup(): Promise<void> {
    return Promise.resolve();
  }

  async acquire(
    verb: LockVerb,
    holder: LockHolder,
    ttlMs: number,
  ): Promise<LockClaim> {
    const ref = this.db.collection(SEEDS_COLLECTION).doc(docId(verb));
    const nowMs = Date.now();
    const newDoc: LockDoc = {
      _kind: KIND_LOCK,
      verb,
      holder: { host: holder.host, pid: holder.pid, label: holder.label },
      acquired_at_ms: nowMs,
      expires_at_ms: nowMs + ttlMs,
      ttl_ms: ttlMs,
    };

    let heldByOther: LockDoc | undefined;
    try {
      await this.db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists) {
          const existing = snap.data() as Partial<LockDoc>;
          if (isHeldAt(existing, nowMs)) {
            heldByOther = existing as LockDoc;
            return;
          }
          // Expired — overwrite. Steal-on-expired is implicit (T8.2).
        }
        tx.set(ref, newDoc);
      });
    } catch (e) {
      throw SeedError.coded(
        "E_INTERNAL",
        `acquire __seeds lock: ${(e as Error).message}`,
        e,
      );
    }

    if (heldByOther) {
      const other = docToClaim(heldByOther);
      throw SeedError.coded(
        "E_RUNNER_LOCKED",
        `lock for ${verb} held by host=${other.holder.host}, pid=${other.holder.pid}, label=${JSON.stringify(other.holder.label)}; expires ${new Date(asNumber(heldByOther.expires_at_ms)).toISOString()}`,
      );
    }

    return {
      verb,
      holder,
      claimedAt: new Date(nowMs).toISOString(),
      heartbeatAt: new Date(nowMs).toISOString(),
      ttlMs,
    };
  }

  async heartbeat(claim: LockClaim): Promise<void> {
    const ref = this.db.collection(SEEDS_COLLECTION).doc(docId(claim.verb));
    const newExpiry = Date.now() + claim.ttlMs;
    try {
      await this.db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return; // force-unlocked — heartbeat is a no-op
        const existing = snap.data() as Partial<LockDoc>;
        if (
          existing.holder?.host !== claim.holder.host ||
          existing.holder?.pid !== claim.holder.pid
        ) {
          // Peer stole the slot. Heartbeat is a no-op.
          return;
        }
        tx.update(ref, {
          expires_at_ms: newExpiry,
          ttl_ms: claim.ttlMs,
        });
      });
    } catch (e) {
      throw SeedError.coded(
        "E_INTERNAL",
        `heartbeat __seeds lock: ${(e as Error).message}`,
        e,
      );
    }
  }

  async release(claim: LockClaim): Promise<void> {
    const ref = this.db.collection(SEEDS_COLLECTION).doc(docId(claim.verb));
    try {
      await this.db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const existing = snap.data() as Partial<LockDoc>;
        if (
          existing.holder?.host !== claim.holder.host ||
          existing.holder?.pid !== claim.holder.pid
        ) {
          return;
        }
        tx.delete(ref);
      });
    } catch (e) {
      throw SeedError.coded(
        "E_INTERNAL",
        `release __seeds lock: ${(e as Error).message}`,
        e,
      );
    }
  }

  async current(verb: LockVerb): Promise<LockClaim | undefined> {
    const snap = await this.db
      .collection(SEEDS_COLLECTION)
      .doc(docId(verb))
      .get();
    if (!snap.exists) return undefined;
    return docToClaim(snap.data() as Partial<LockDoc>);
  }

  async forceUnlock(verb: LockVerb): Promise<void> {
    try {
      await this.db.collection(SEEDS_COLLECTION).doc(docId(verb)).delete();
    } catch (e) {
      throw SeedError.coded(
        "E_INTERNAL",
        `force-unlock __seeds lock: ${(e as Error).message}`,
        e,
      );
    }
  }
}

// Surface KIND_FIELD so the backend module can also import it without
// reaching across to tracking.
export { KIND_FIELD } from "./tracking.js";
