import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CapturingEmitter,
  compareEventShapes,
  hashCanonical,
  parseNdjson,
  type OwnedWrite,
  type Seed,
  type SeedAction,
  SeedConfig,
  SeedRunner,
} from "@servicecute/seed-core";
import { initializeApp, getApps, deleteApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

import { FirestoreBackend, SEEDS_COLLECTION } from "../src/index.js";

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
