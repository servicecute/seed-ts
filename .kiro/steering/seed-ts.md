---
trigger: model_decision
---

# seed-ts Usage Rules

TypeScript implementation of the **seed CLI/runner spec** at
[registry/seed-spec/seed-spec.md](https://github.com/servicecute/project-registry/blob/main/seed-spec/seed-spec.md)
(v0.4.3).

| Package | Role |
|---|---|
| `@servicecute/seed-core` | Backend-agnostic core: registry primitive, NDJSON event schema, error codes, `Tracking`/`Lock`/`DbBackend` interfaces, `SeedRunner` orchestration, transformer + ref markers, schema registry round-trip + AJV draft-2020-12 validation. |
| `@servicecute/surrealdb-seed` | SurrealDB v2 adapter; ships `schemaForSurreal` helper. |
| `@servicecute/firestore-seed` | Firestore (`firebase-admin`) adapter; ships `schemaForFirestore` helper. |

Sibling reference: `rust-workspace/lib-seed-*` (the Rust
implementation of the same spec). When ambiguity arises, look there
first — both implementations share task IDs (T1–T16).

## When to use

- Elysia / bun service needs deterministic, idempotent dev/staging seed
  data with drift detection, scope gating, reset semantics.
- A CLI verb surface for `seed apply / status / reset` matching the
  cross-language spec.
- Cross-language portability: a JSON snapshot can feed seeds in any
  language (§14.7) — fixtures + caches round-trip between this repo
  and `rust-workspace/seed-parity/`.

## When NOT to use

- **Production data** — seeds are scope-gated to `development` /
  `staging` (§9). Production-required data is migration material; see
  spec §7.3.
- **Schema migrations** — that's a different runner. Seeds run AFTER
  migrations create tables.
- **Production credential bootstrap** — spec §14.8 forbids it.

## Project layout (workspace-binding, mirrors spec §19.4)

```
my-elysia-service/
├── seeds/
│   └── baseline-countries/
│       └── data/
│           └── countries.json
├── src/
│   ├── seeds/
│   │   ├── index.ts                  ← `export * from "./baseline-countries.js"`
│   │   └── baseline-countries.ts     ← Seed metadata + class implements SeedAction
│   ├── seedRegistry.ts               ← single auditable list (§4.2)
│   └── api.ts
└── tasks.md
```

**Per-seed file shape** (`src/seeds/baseline-countries.ts`):

```ts
import {
  hashCanonical,
  type OwnedWrite,
  type Seed,
  type SeedAction,
} from "@servicecute/seed-core";

const COUNTRIES_JSON: string = await Bun.file(
  new URL("../../seeds/baseline-countries/data/countries.json", import.meta.url),
).text();

interface CountryFixture {
  iso: string;
  name: string;
}

export class BaselineCountries implements SeedAction {
  async produce(): Promise<OwnedWrite[]> {
    const fixtures = JSON.parse(COUNTRIES_JSON) as CountryFixture[];
    return fixtures.map((c) => ({
      table: "countries",
      key: c.iso,
      data: { iso: c.iso, name: c.name },
    }));
  }
}

export function metadata(): Seed {
  return {
    name: "baseline-countries",
    scope: ["development"],
    dependsOn: [],
    requires: [],
    requiresSchemas: { countries: "1" },
    keyHash: hashCanonical(COUNTRIES_JSON),
  };
}
```

**Single registry file shape** (`src/seedRegistry.ts`):

The recommended pattern is **scope routing** (spec §9.3): register a
lazy backend factory for each scope label your service supports.
`production` is forbidden as a registered name — services that don't
register a "production" factory cannot reach production. The runner
selects the active factory using the configured `scopeTarget` (or the
per-call `--scope` override per §9.5) and resolves it on first use.

```ts
import { ScopedBackends, SeedConfig } from "@servicecute/seed-core";
import { SurrealBackend, schemaForSurreal } from "@servicecute/surrealdb-seed";
import { t } from "elysia";

import * as baselineCountries from "./seeds/baseline-countries.js";

const Country = t.Object({
  iso: t.String({ minLength: 2, maxLength: 2 }),
  name: t.String(),
});

export function buildSeedConfig(): SeedConfig<SurrealBackend> {
  const backends = new ScopedBackends<SurrealBackend>();
  backends.register("development", async () => {
    const db = await connectDev();
    return new SurrealBackend(db);
  });
  backends.register("staging", async () => {
    const db = await connectStaging();
    return new SurrealBackend(db);
  });
  // Note: NO "production" factory — production is unreachable
  // from the seed runner by design (§7.3 + §9.3).

  const config = new SeedConfig({
    backends,
    scopeTarget: process.env.SURREAL_NAMESPACE ?? "development",
    holderLabel: process.argv.slice(2).join(" "),
  });

  // Seeds — one register pair per seed, alphabetised.
  config.seeds.register("baseline-countries", baselineCountries.metadata());
  config.actions.register("baseline-countries", new baselineCountries.BaselineCountries());

  // Schemas — TypeBox passes through directly (already JSON Schema 2020-12).
  config.schemas.register("countries", schemaForSurreal("countries", "1", Country));

  return config;
}
```

**Single-backend escape hatch.** `new SeedConfig({ backend, scopeTarget,
... })` still works; equivalent to a single-factory router resolved
under the configured `scopeTarget`. Tests and the simplest services
prefer it.

## Schema lib bridges

The backend-specific helpers live in their adapter packages
(`schemaForSurreal` in `@servicecute/surrealdb-seed`, `schemaForFirestore`
in `@servicecute/firestore-seed`). Core stays backend-agnostic.

| Lib | Bridge |
|---|---|
| **TypeBox** (elysia `t`) | Pass directly. TBox produces JSON Schema 2020-12. |
| **Zod** | `schemaForSurreal("name", "1", zodToJsonSchema(User))` — install `zod-to-json-schema` as a dep. |
| **Hand-written JSON Schema** | Pass the object literal. |

`@servicecute/seed-core` deliberately doesn't bundle Zod or TypeBox.
AJV runs draft-2020-12 validation against whatever you hand in.

## Transformer markers (§14)

For values like password hashes / KMS-encrypted PII:

```ts
import { marker } from "@servicecute/seed-core";

return [{
  table: "users",
  key: `user-${email}`,
  data: {
    email,
    password_hash: marker("bcrypt", "demo-pass"),
  },
}];
```

The runner walks each record at write time and calls the registered
transformer. Markers are FORBIDDEN in JSON data files (§14.4) — load
the file in code, then build markers programmatically.

## Ref markers (§7)

For cross-seed references:

```ts
import { refMarker } from "@servicecute/seed-core";

return [{
  table: "workspaces",
  key: "demo-acme",
  data: {
    name: "Acme",
    owner_id: refMarker("users", "demo-alice"),
  },
}];
```

Resolution at write time: existence check via `DbBackend.recordExists`,
then rewrite to backend wire form (`users:demo-alice` for SurrealDB,
`users/demo-alice` for Firestore).

## Drift detection (§5)

`Seed.keyHash = hashCanonical(sourceText)` — typically the seed's data
file or whatever inputs determine its identity. The runner refuses to
silently re-apply a seed whose hash changed. Cosmetic source edits
(comments, whitespace) don't false-positive thanks to the §19.3
canonicalization.

## Output format (§11.4)

The CLI dispatch's `format: text|json` flag chooses the emitter.
Consumers parse it before constructing the runner:

```ts
import { emitterFor, type SeedCommand } from "@servicecute/seed-core";

const cmd: SeedCommand = parseArgsSomehow(process.argv);
const config = new SeedConfig({
  backend,
  scopeTarget,
  emitter: emitterFor("format" in cmd ? cmd.format : "json"),
});
```

`TextEmitter` suppresses ANSI when stdout isn't a TTY (T5.5).

## Cargo / bun conventions

- Bun ≥ 1.1, Node ≥ 20.
- TypeScript 5.9, strict + composite project references +
  `noUncheckedIndexedAccess` + `verbatimModuleSyntax`.
- `bun test` is the test runner. No jest/vitest.
- AJV 8 for JSON Schema 2020-12 validation.

## Outstanding (see tasks.md)

- T11.2: first consumer wire-in (waiting on user direction).
- T12: generator + cache pipeline (`regenerate` verb body).
- T13: full runner-context API (`ctx.upsert`, `ctx.loadJson`, typed
  `Ref<T>`). Today seeds drive writes through `SeedAction.produce` +
  `marker` / `refMarker` JSON helpers — that's enough to ship.
- T14.3: SCHEMAFULL UNIQUE cross-check (needs schema introspection).

## See also

- `registry/seed-spec/seed-spec.md` v0.4.3 — load-bearing artifact.
- `seed-parity/` — cross-language fixtures byte-equivalent to
  `rust-workspace/seed-parity/`.
- `rust-workspace/lib-seed-*` — the Rust implementation of the same
  spec; first place to look when behaviour is ambiguous.
