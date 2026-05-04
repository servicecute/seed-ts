/**
 * Reference TypeScript seed body for the parity suite.
 *
 * Each conformant TS runner builds a `Seed` + `SeedAction` from this
 * file (or the runner's idiomatic shape) and applies it. Lives outside
 * any package — it's fixture data, not a compilation target.
 *
 * The TS integration tests under
 * `packages/{surrealdb,firestore}-seed/test/parity.test.ts`
 * reproduce its semantics in TS code.
 */

import {
  hashCanonical,
  marker,
  type OwnedWrite,
  type Seed,
  type SeedAction,
} from "@servicecute/seed-core";

interface CountryFixture {
  iso: string;
  name: string;
}

const COUNTRIES: CountryFixture[] = [
  { iso: "US", name: "United States" },
  { iso: "GB", name: "United Kingdom" },
  { iso: "JP", name: "Japan" },
];

export class BaselineCountries implements SeedAction {
  async produce(): Promise<OwnedWrite[]> {
    return COUNTRIES.map((c) => ({
      table: "countries",
      key: c.iso,
      data: { iso: c.iso, name: c.name },
    }));
  }
}

export function metadata(sourceText: string): Seed {
  return {
    name: "baseline-countries",
    scope: ["development"],
    dependsOn: [],
    requires: [],
    requiresSchemas: {},
    keyHash: hashCanonical(sourceText),
  };
}

// `marker(...)` import kept so reviewers see the transformer marker
// API is in scope for fixtures that need it (e.g. password seeds).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _exampleMarker = marker("bcrypt", "demo-pass");
