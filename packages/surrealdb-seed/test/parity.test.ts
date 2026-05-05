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
import { Surreal } from "surrealdb";

import { SurrealBackend } from "../src/index.js";

/**
 * Spec §21 + §11.5.4 parity test (T10.2 + T10.4).
 *
 * Skipped unless `PARITY=1` is set (along with `SURREAL_PARITY_URL`)
 * — the harness compiles in CI but doesn't run without DB infra.
 *
 * Required env:
 *   PARITY=1                 enables the suite
 *   SURREAL_PARITY_URL       e.g. ws://localhost:8000
 *   SURREAL_PARITY_USER      defaults to root
 *   SURREAL_PARITY_PASS      defaults to root
 *   SURREAL_NS               defaults to development (matches scope_target)
 *   SURREAL_DB               defaults to seedparity
 */

const PARITY_ENABLED =
  process.env["PARITY"] === "1" && !!process.env["SURREAL_PARITY_URL"];

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

async function connectTestDb(): Promise<Surreal> {
  const url = process.env["SURREAL_PARITY_URL"]!;
  const user = process.env["SURREAL_PARITY_USER"] ?? "root";
  const pass = process.env["SURREAL_PARITY_PASS"] ?? "root";
  // Default ns matches the configured scope_target so the §9.4
  // cross-check passes. Override via SURREAL_NS to run against a
  // different environment.
  const ns = process.env["SURREAL_NS"] ?? "development";
  const db = process.env["SURREAL_DB"] ?? "seedparity";

  const surreal = new Surreal();
  await surreal.connect(url);
  await surreal.signin({ username: user, password: pass });
  await surreal.use({ namespace: ns, database: db });
  return surreal;
}

async function dropTestState(db: Surreal): Promise<void> {
  // Clean slate so the test is repeatable.
  for (const stmt of [
    "REMOVE TABLE IF EXISTS countries;",
    "REMOVE TABLE IF EXISTS __seeds;",
    "REMOVE TABLE IF EXISTS __seeds_lock;",
  ]) {
    await db.query(stmt);
  }
}

describe.skipIf(!PARITY_ENABLED)("SurrealDB parity (T10.2 + T10.4)", () => {
  it("applies baseline-countries to the expected end-state", async () => {
    const db = await connectTestDb();
    try {
      await dropTestState(db);

      const backend = new SurrealBackend(db);
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

      // ---- T10.2: end-state equivalence -----------------------------
      type CountryRow = { iso: string; name: string };
      const result = await db.query<[CountryRow[]]>(
        "SELECT iso, name FROM countries ORDER BY iso",
      );
      const rows = result[0] ?? [];
      expect(rows.length).toBe(3);
      const byIso = new Map(rows.map((r) => [r.iso, r.name]));
      expect(byIso.get("US")).toBe("United States");
      expect(byIso.get("GB")).toBe("United Kingdom");
      expect(byIso.get("JP")).toBe("Japan");

      const backendForRead = await runner.config.resolveBackend("development");
      const tracked = await backendForRead.tracking().get("baseline-countries");
      expect(tracked).toBeDefined();
      expect(tracked!.pathsTouched).toEqual([
        "countries:GB",
        "countries:JP",
        "countries:US",
      ]);
      expect(tracked!.scope).toEqual(["development"]);
      expect(tracked!.trackingSchemaVersion).toBe("1");
      expect(tracked!.specVersion).toBe("0.4.3");

      // ---- T10.4: NDJSON event-shape diff ---------------------------
      const captured = emitter.drain();
      const expected = parseNdjson(EXPECTED_EVENTS);
      compareEventShapes(expected, captured);
    } finally {
      await db.close().catch(() => {});
    }
  });

  it("apply → reset returns to a pristine state", async () => {
    const db = await connectTestDb();
    try {
      await dropTestState(db);

      const backend = new SurrealBackend(db);
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

      const result = await db.query<[{ n: number }[]]>(
        "SELECT count() AS n FROM countries GROUP ALL",
      );
      const count = result[0]?.[0]?.n ?? 0;
      expect(count).toBe(0);

      const trackingList = await (
        await runner.config.resolveBackend("development")
      )
        .tracking()
        .list();
      expect(trackingList).toEqual([]);
    } finally {
      await db.close().catch(() => {});
    }
  });
});
