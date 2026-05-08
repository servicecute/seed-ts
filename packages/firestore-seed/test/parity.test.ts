import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CapturingEmitter,
  compareEventShapes,
  hashCanonical,
  type CreateIdentityRequest,
  type IdentityBinding,
  type KeyExpr,
  type OwnedWrite,
  parseNdjson,
  refMarkerByEmail,
  refMarkerByField,
  type Seed,
  type SeedAction,
  SeedConfig,
  SeedRunner,
} from "@servicecute/seed-core";
import { initializeApp, getApps, deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

import {
  FirebaseAdminIdentityProvider,
  FirestoreBackend,
  SEEDS_COLLECTION,
} from "../src/index.js";

/**
 * Spec §21 + §11.5.4 parity test (T10.3 + T10.4).
 *
 * Skipped unless `PARITY=1` is set (along with
 * `FIRESTORE_EMULATOR_HOST`).
 *
 * Required env:
 *   PARITY=1                       enables the suite
 *   FIRESTORE_EMULATOR_HOST        e.g. localhost:8080
 *   FIRESTORE_PARITY_PROJECT       defaults to development (matches scope_target)
 */

const PARITY_ENABLED =
  process.env["PARITY"] === "1" && !!process.env["FIRESTORE_EMULATOR_HOST"];

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "..", "..", "seed-parity");
const COUNTRIES_JSON = readFileSync(
  join(FIXTURES_DIR, "fixtures", "countries.json"),
  "utf8",
);
const EXPECTED_EVENTS = readFileSync(
  join(FIXTURES_DIR, "expected", "apply.events.ndjson"),
  "utf8",
);

interface CountryFixture {
  iso: string;
  name: string;
}

class BaselineCountries implements SeedAction {
  async produce(): Promise<OwnedWrite[]> {
    const fixtures = JSON.parse(COUNTRIES_JSON) as CountryFixture[];
    return fixtures.map((c) => ({
      table: "countries",
      key: c.iso,
      data: { iso: c.iso, name: c.name },
    }));
  }
}

function baselineCountriesSeed(): Seed {
  return {
    name: "baseline-countries",
    scope: ["development"],
    dependsOn: [],
    requires: [],
    requiresSchemas: {},
    keyHash: hashCanonical(COUNTRIES_JSON),
  };
}

function connectTestDb(): Firestore {
  if (getApps().length === 0) {
    // Default project = "development" so the §9.4 cross-check
    // (scope_target == project_id) passes without configuration.
    initializeApp({
      projectId:
        process.env["FIRESTORE_PARITY_PROJECT"] ?? "development",
    });
  }
  return getFirestore();
}

async function dropTestState(db: Firestore): Promise<void> {
  // Spec §18.2 forbids recursive-delete utilities. The test only
  // creates known doc IDs, so we delete those by name.
  const docs: Array<[string, string]> = [
    ["countries", "US"],
    ["countries", "GB"],
    ["countries", "JP"],
    [SEEDS_COLLECTION, "baseline-countries"],
    [SEEDS_COLLECTION, "_lock_apply"],
    [SEEDS_COLLECTION, "_lock_regenerate"],
  ];
  for (const [col, id] of docs) {
    await db.collection(col).doc(id).delete().catch(() => {});
  }
}

describe.skipIf(!PARITY_ENABLED)("Firestore parity (T10.3 + T10.4)", () => {
  it("applies baseline-countries to the expected end-state", async () => {
    const db = connectTestDb();
    try {
      await dropTestState(db);

      const backend = new FirestoreBackend(db);
      const emitter = new CapturingEmitter();
      const config = new SeedConfig({
        backend,
        scopeTarget: "development",
        holderLabel: "parity-test",
        emitter,
      });
      config.seeds.register("baseline-countries", baselineCountriesSeed());
      config.actions.register("baseline-countries", new BaselineCountries());
      const runner = new SeedRunner(config);

      await runner.apply([]);

      // ---- T10.3: end-state equivalence -----------------------------
      const expectedCountries: Array<[string, string]> = [
        ["US", "United States"],
        ["GB", "United Kingdom"],
        ["JP", "Japan"],
      ];
      for (const [id, expectedName] of expectedCountries) {
        const snap = await db.collection("countries").doc(id).get();
        expect(snap.exists).toBe(true);
        const data = snap.data() as { iso: string; name: string };
        expect(data.iso).toBe(id);
        expect(data.name).toBe(expectedName);
      }

      const backendForRead = await runner.config.resolveBackend("development");
      const tracked = await backendForRead.tracking().get("baseline-countries");
      expect(tracked).toBeDefined();
      expect(tracked!.pathsTouched).toEqual([
        "countries/GB",
        "countries/JP",
        "countries/US",
      ]);
      expect(tracked!.scope).toEqual(["development"]);
      expect(tracked!.trackingSchemaVersion).toBe("1");
      expect(tracked!.specVersion).toBe("0.4.3");

      // tracking().list() MUST exclude lock docs (the `_kind`
      // discriminator filter introduced under T4.2).
      const listed = await backendForRead.tracking().list();
      expect(listed.length).toBe(1);
      expect(listed[0]!.name).toBe("baseline-countries");

      // ---- T10.4: NDJSON event-shape diff ---------------------------
      const captured = emitter.drain();
      const expected = parseNdjson(EXPECTED_EVENTS);
      compareEventShapes(expected, captured);
    } finally {
      await Promise.all(getApps().map((a) => deleteApp(a)));
    }
  });

  it("apply → reset returns to a pristine state", async () => {
    const db = connectTestDb();
    try {
      await dropTestState(db);

      const backend = new FirestoreBackend(db);
      const config = new SeedConfig({
        backend,
        scopeTarget: "development",
        holderLabel: "parity-test",
      });
      config.seeds.register("baseline-countries", baselineCountriesSeed());
      config.actions.register("baseline-countries", new BaselineCountries());
      const runner = new SeedRunner(config);

      await runner.apply([]);
      await runner.resetAll(true);

      for (const id of ["US", "GB", "JP"]) {
        const snap = await db.collection("countries").doc(id).get();
        expect(snap.exists).toBe(false);
      }

      const listed = await (
        await runner.config.resolveBackend("development")
      )
        .tracking()
        .list();
      expect(listed).toEqual([]);
    } finally {
      await Promise.all(getApps().map((a) => deleteApp(a)));
    }
  });
});

// ────────────────── §25 + §13.4 + §7.1 extensions ──────────────────

/**
 * Throwaway personas matching what the Rust parity test mints.
 * Both sides MUST emit the same uids — the Firebase emulator hashes
 * email → uid deterministically per project, so identical inputs
 * produce identical outputs.
 */
const PARITY_PERSONAS: Array<{
  email: string;
  displayName: string;
  password: string;
}> = [
  { email: "alice@parity.demo", displayName: "Alice Parity", password: "demo-pass-1" },
  { email: "bob@parity.demo", displayName: "Bob Parity", password: "demo-pass-2" },
];

const PARITY_AUTH_COLLECTION = "__parity_users";
const PARITY_PRODUCTS_COLLECTION = "__parity_products";

function reqOf(p: { email: string; displayName: string; password: string }): CreateIdentityRequest {
  return {
    email: p.email,
    password: p.password,
    emailVerified: true,
    displayName: p.displayName,
    disabled: false,
    customClaims: {},
    params: null,
  };
}

class ParityUsersAction implements SeedAction {
  async produce(): Promise<OwnedWrite[]> {
    return PARITY_PERSONAS.map((p) => ({
      // key is a placeholder; the runner replaces it with the
      // minted uid via key_from_uid.
      table: PARITY_AUTH_COLLECTION,
      key: p.email,
      data: { email: p.email, display_name: p.displayName, firebase_uid: null },
    }));
  }
}

function parityUsersSeed(): Seed {
  return {
    name: "parity-users",
    scope: ["development"],
    dependsOn: [],
    requires: [],
    requiresSchemas: {},
    identities: {
      personas: {
        provider: "firebase",
        source: { kind: "inline", requests: PARITY_PERSONAS.map(reqOf) },
        uidTargets: ["/firebase_uid"],
        matchField: "/email",
        keyFromUid: true,
        upsertStrategy: "skipIfEmailExists",
      },
    },
    keyHash: hashCanonical(JSON.stringify(PARITY_PERSONAS)),
  };
}

/**
 * Cross-seed reference test — products own a `seller_email` field
 * that resolves via `$ref` by-field to the user's minted uid.
 */
class ParityProductsAction implements SeedAction {
  async produce(): Promise<OwnedWrite[]> {
    return [
      {
        table: PARITY_PRODUCTS_COLLECTION,
        key: "p1",
        data: {
          name: "Notebook",
          slug: "notebook",
          // Email-form ref → bare resolved uid string
          owner_uid: refMarkerByEmail(
            PARITY_AUTH_COLLECTION,
            PARITY_PERSONAS[0]!.email,
          ),
        },
      },
      {
        table: PARITY_PRODUCTS_COLLECTION,
        key: "p2",
        data: {
          name: "Pen",
          slug: "pen",
          // Generic by-field — exercises the §7.1.1 generalization
          // even though `email` would also work; the difference is
          // the spec contract, not the runtime behaviour.
          owner_uid: refMarkerByField(
            PARITY_AUTH_COLLECTION,
            "email",
            PARITY_PERSONAS[1]!.email,
          ),
        },
      },
    ];
  }
}

function parityProductsSeed(): Seed {
  return {
    name: "parity-products",
    scope: ["development"],
    dependsOn: ["parity-users"],
    requires: [],
    requiresSchemas: {},
    constraints: {
      // §13.4 ext: declare that owner_uid MUST point at a parity-users record.
      foreignKey: [
        {
          path: PARITY_PRODUCTS_COLLECTION,
          field: "owner_uid",
          references: PARITY_AUTH_COLLECTION,
        },
      ],
    },
    keyHash: "sha256:parity-products-v1",
  };
}

async function dropParityIdentitiesAndDocs(db: Firestore): Promise<void> {
  // Sweep tracking + collections from prior runs. We clear by known
  // keys + a list-and-delete of dynamic users since their doc keys
  // are uids.
  for (const id of ["parity-users", "parity-products"]) {
    await db.collection(SEEDS_COLLECTION).doc(id).delete().catch(() => {});
  }
  for (const col of [PARITY_AUTH_COLLECTION, PARITY_PRODUCTS_COLLECTION]) {
    const snap = await db.collection(col).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  // Tear down auth identities by email so a re-run starts clean.
  const auth = getAuth();
  for (const p of PARITY_PERSONAS) {
    try {
      const u = await auth.getUserByEmail(p.email);
      await auth.deleteUser(u.uid);
    } catch {
      // not-found is fine
    }
  }
}

describe.skipIf(!PARITY_ENABLED)("Firestore + Firebase Auth parity (§25 + §7.1 + §13.4)", () => {
  it("paired identity-data lifecycle: apply → assert → reset → assert", async () => {
    const db = connectTestDb();
    try {
      await dropParityIdentitiesAndDocs(db);

      const backend = new FirestoreBackend(db);
      const config = new SeedConfig({
        backend,
        scopeTarget: "development",
        holderLabel: "parity-identity",
      });
      config.seeds.register("parity-users", parityUsersSeed());
      config.actions.register("parity-users", new ParityUsersAction());
      config.seeds.register("parity-products", parityProductsSeed());
      config.actions.register("parity-products", new ParityProductsAction());
      config.identityProviders.register(
        "firebase",
        new FirebaseAdminIdentityProvider(),
      );
      const runner = new SeedRunner(config);

      // Apply both seeds in topo order (parity-products dependsOn
      // parity-users; runner resolves automatically with empty list).
      await runner.apply([]);

      // ---- Assert: Firebase Auth has 2 minted identities ----------
      const auth = getAuth();
      const aliceAuth = await auth.getUserByEmail(PARITY_PERSONAS[0]!.email);
      const bobAuth = await auth.getUserByEmail(PARITY_PERSONAS[1]!.email);
      expect(aliceAuth.uid).toBeTruthy();
      expect(bobAuth.uid).toBeTruthy();

      // ---- Assert: Firestore docs are keyed by the uids -----------
      const aliceDoc = await db
        .collection(PARITY_AUTH_COLLECTION)
        .doc(aliceAuth.uid)
        .get();
      expect(aliceDoc.exists).toBe(true);
      const aliceData = aliceDoc.data() as { firebase_uid: string };
      expect(aliceData.firebase_uid).toBe(aliceAuth.uid);

      // ---- Assert: products' `$ref` resolved to the bare uids -----
      const p1 = await db.collection(PARITY_PRODUCTS_COLLECTION).doc("p1").get();
      expect((p1.data() as { owner_uid: string }).owner_uid).toBe(aliceAuth.uid);
      const p2 = await db.collection(PARITY_PRODUCTS_COLLECTION).doc("p2").get();
      expect((p2.data() as { owner_uid: string }).owner_uid).toBe(bobAuth.uid);

      // ---- Assert: tracking row carries createdIdentities ---------
      const tracked = await backend.tracking().get("parity-users");
      expect(tracked!.createdIdentities?.length).toBe(2);
      expect(tracked!.createdIdentities?.map((t) => t.email).sort()).toEqual([
        "alice@parity.demo",
        "bob@parity.demo",
      ]);

      // ---- Reset --------------------------------------------------
      await runner.resetAll(true);

      // Both Firestore collections empty.
      for (const col of [PARITY_AUTH_COLLECTION, PARITY_PRODUCTS_COLLECTION]) {
        const snap = await db.collection(col).get();
        expect(snap.empty).toBe(true);
      }
      // Auth identities torn down.
      for (const p of PARITY_PERSONAS) {
        await expect(auth.getUserByEmail(p.email)).rejects.toMatchObject({
          code: "auth/user-not-found",
        });
      }
    } finally {
      await Promise.all(getApps().map((a) => deleteApp(a)));
    }
  });

  it("foreign_key hint surfaces E_CONSTRAINT_FK on missing target", async () => {
    const db = connectTestDb();
    try {
      await dropParityIdentitiesAndDocs(db);

      const backend = new FirestoreBackend(db);
      const config = new SeedConfig({
        backend,
        scopeTarget: "development",
        holderLabel: "parity-fk",
      });
      // Skip applying parity-users — the FK target intentionally
      // doesn't exist.
      config.seeds.register("parity-products", {
        ...parityProductsSeed(),
        // Drop the depends_on so the runner doesn't refuse.
        dependsOn: [],
      });
      config.actions.register(
        "parity-products",
        new (class implements SeedAction {
          async produce(): Promise<OwnedWrite[]> {
            return [
              {
                table: PARITY_PRODUCTS_COLLECTION,
                key: "orphan",
                data: {
                  name: "Orphan",
                  // Hardcoded uid — no $ref, no upstream record.
                  owner_uid: "user-does-not-exist",
                },
              },
            ];
          }
        })(),
      );
      const runner = new SeedRunner(config);

      await expect(runner.apply([])).rejects.toThrow(/E_CONSTRAINT_FK/);
    } finally {
      await Promise.all(getApps().map((a) => deleteApp(a)));
    }
  });
});

// ────────────────── §26 templated doc keys ──────────────────

const PARITY_MEMBERSHIPS_COLLECTION = "memberships";

/**
 * Cross-language parity invariant. This exact string MUST be the doc
 * id both the TS and the Rust implementation produce for the
 * `(prefix="memberships_", parts=[/groupId, /userId])` template
 * applied against `{groupId: "group-acme", userId: "user-alice-uid-123"}`.
 *
 * If either side drifts (different SHA-256 implementation, different
 * byte encoding, different hex casing), this assertion fails. The
 * matching Rust assertion lives in
 * `lib-firestore-seed/tests/parity.rs::parity_key_template_round_trip`
 * and embeds the same literal.
 */
const EXPECTED_TEMPLATED_KEY =
  "memberships_cf6964951e6e2a3dc36b70b64bd4f3a64fb63cf336170f43339de72c6e8ae220";

class ParityMembershipsAction implements SeedAction {
  async produce(): Promise<OwnedWrite[]> {
    return [
      {
        table: PARITY_MEMBERSHIPS_COLLECTION,
        // Placeholder — runner overwrites via keyTemplates().
        key: "membership-stub",
        data: {
          groupId: "group-acme",
          userId: "user-alice-uid-123",
        },
      },
    ];
  }

  keyTemplates(): Map<string, KeyExpr> {
    const template: KeyExpr = {
      kind: "sha256_hex",
      prefix: "memberships_",
      parts: [
        { source: "data_path", pointer: "/groupId" },
        { source: "data_path", pointer: "/userId" },
      ],
    };
    return new Map([
      [`${PARITY_MEMBERSHIPS_COLLECTION}\x00membership-stub`, template],
    ]);
  }
}

function parityMembershipsSeed(): Seed {
  return {
    name: "parity-memberships",
    scope: ["development"],
    dependsOn: [],
    requires: [],
    requiresSchemas: {},
    keyHash: hashCanonical("group-acme|user-alice-uid-123"),
  };
}

async function dropTemplatedState(db: Firestore): Promise<void> {
  const docs: Array<[string, string]> = [
    [PARITY_MEMBERSHIPS_COLLECTION, "membership-stub"],
    [PARITY_MEMBERSHIPS_COLLECTION, EXPECTED_TEMPLATED_KEY],
    [SEEDS_COLLECTION, "parity-memberships"],
    [SEEDS_COLLECTION, "_lock_apply"],
  ];
  for (const [col, id] of docs) {
    await db.collection(col).doc(id).delete().catch(() => {});
  }
}

describe.skipIf(!PARITY_ENABLED)("Firestore parity §26 (KeyExpr)", () => {
  it("templated key matches Rust output byte-for-byte", async () => {
    const db = connectTestDb();
    try {
      await dropTemplatedState(db);

      const backend = new FirestoreBackend(db);
      const config = new SeedConfig({
        backend,
        scopeTarget: "development",
        holderLabel: "parity-key-template",
      });
      config.seeds.register("parity-memberships", parityMembershipsSeed());
      config.actions.register(
        "parity-memberships",
        new ParityMembershipsAction(),
      );
      const runner = new SeedRunner(config);

      await runner.apply([]);

      // 1. Placeholder MUST NOT exist — the template overwrote it.
      const placeholder = await db
        .collection(PARITY_MEMBERSHIPS_COLLECTION)
        .doc("membership-stub")
        .get();
      expect(placeholder.exists).toBe(false);

      // 2. The cross-language-fixed final key MUST exist with the
      //    resolved data. Same literal as the Rust parity test —
      //    drift on either side fails this assertion.
      const finalDoc = await db
        .collection(PARITY_MEMBERSHIPS_COLLECTION)
        .doc(EXPECTED_TEMPLATED_KEY)
        .get();
      expect(finalDoc.exists).toBe(true);
      const data = finalDoc.data() as { groupId: string; userId: string };
      expect(data.groupId).toBe("group-acme");
      expect(data.userId).toBe("user-alice-uid-123");

      // 3. Tracking records the FINAL templated key (§26.3 ends with
      //    tracking; reset deletes by recorded path).
      const tracking = await (
        await runner.config.resolveBackend("development")
      )
        .tracking()
        .get("parity-memberships");
      expect(tracking).toBeDefined();
      expect(tracking!.pathsTouched).toEqual([
        `${PARITY_MEMBERSHIPS_COLLECTION}/${EXPECTED_TEMPLATED_KEY}`,
      ]);

      // 4. Reset takes both data and tracking back to empty.
      await runner.resetAll(true);
      const after = await db
        .collection(PARITY_MEMBERSHIPS_COLLECTION)
        .doc(EXPECTED_TEMPLATED_KEY)
        .get();
      expect(after.exists).toBe(false);
    } finally {
      await Promise.all(getApps().map((a) => deleteApp(a)));
    }
  });
});
