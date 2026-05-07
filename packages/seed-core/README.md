# @servicecute/seed-core

Backend-agnostic core for the seed CLI/runner — TypeScript port of
`lib-seed-core`. **Spec v0.5.0 conformant** (via the
`@servicecute/firestore-seed` adapter; SurrealDB at v0.4.3 — see
[§25 scoreboard](https://github.com/servicecute/project-registry/blob/main/seed-spec/seed-spec.md)).

## Spec

[seed-spec.md](https://github.com/servicecute/project-registry/blob/main/seed-spec/seed-spec.md)
in the project registry. Cross-language portability is byte-level
where the spec calls for it (cache files, tracking shapes) — same
fixtures must produce identical wire output across Rust + TS.

## Install

```bash
bun add @servicecute/seed-core
# plus a backend adapter:
bun add @servicecute/firestore-seed   # or @servicecute/surrealdb-seed
```

## What this package owns

- `Registry<T>` primitive (§4) and concrete registries:
  `SchemaRegistry`, `TransformerRegistry`, `GeneratorRegistry`,
  `PricingRegistry`, `SeedRegistry`, `IdentityProviderRegistry`.
- `Generator` and `Transformer` interfaces (§17, §14); concrete
  `LlmGenerator` ships in-tree.
- `IdentityProvider` interface + `IdentityBinding` + lifecycle
  (§24). Mints/looks up/deletes auth identities alongside the data
  write; tears them down on reset.
- `Lock` and `Tracking` interfaces (§8.4, §10) — backends implement.
- `DbBackend` seam: every backend-specific operation goes through
  this interface, including `findKeyByField` for §7.1 by-field
  `$ref` resolution.
- `SeedRunner` orchestration: lock acquisition, dependency
  resolution, drift detection, transformer + ref + identity
  resolution, schema validation, constraint pre-checks (§13.4 —
  `unique`, `notNull`, `foreignKey`), NDJSON events.
- §7.1 ref machinery: `RefTarget` discriminated union (`key` +
  `field` shapes), `refMarker` / `refMarkerByField` /
  `refMarkerByEmail` builders.
- `ErrorCode` allow-list (`E_IDENTITY_FAILED`, `E_CONSTRAINT_FK`
  among others) and `exitCodeFor` mapping (§11.5.2).
- NDJSON `Event` shape (§11.5).

## What this package does NOT own

- SurrealDB DDL or `__seeds` schema → `@servicecute/surrealdb-seed`.
- Firestore document layout, batched-write chunking →
  `@servicecute/firestore-seed`.
- LLM provider clients → user-supplied `LlmProvider` impls (no
  `lib-llm` equivalent in TS land).
- Concrete `IdentityProvider` impls → adapter packages ship them
  (`@servicecute/firestore-seed` exports `FirebaseAdminIdentityProvider`,
  `@surrealdb-auth/client` exports `SurrealAuthIdentityProvider`).

## Usage

```ts
import { SeedConfig, SeedRunner } from '@servicecute/seed-core';
import { FirestoreBackend } from '@servicecute/firestore-seed';

const backend = new FirestoreBackend(firestoreDb);
const config = new SeedConfig({ backend, scopeTarget: 'development' });
// register schemas, transformers, generators, seeds...
const runner = new SeedRunner(config);
await runner.apply(['baseline-tenants']);
```

### Identity bindings (§24)

```ts
import type { IdentityBinding } from '@servicecute/seed-core';

const binding: IdentityBinding = {
  provider: 'firebase',  // matches identityProviders registry name
  source: { kind: 'inline', requests: [
    { email: 'alice@example.com', password: 'hunter2', emailVerified: true,
      displayName: 'Alice', disabled: false, customClaims: {}, params: null },
  ]},
  uidTargets: ['/id', '/customer/id'],
  matchField: '/email',
  keyFromUid: true,                      // doc key ← minted uid
  upsertStrategy: 'skipIfEmailExists',
};
seed.identities = { personas: binding };
```

### Cross-seed `$ref` (§7.1)

```ts
import { refMarker, refMarkerByEmail, refMarkerByField } from '@servicecute/seed-core';

// Direct doc-key ref → wire form is the path string
refMarker('users', 'alice');                       // "users/alice" or "users:alice"

// Email sugar — resolved via DbBackend.findKeyByField
refMarkerByEmail('users', 'alice@x.com');          // bare resolved key

// Generic by-field — slug, code, isbn, ...
refMarkerByField('products', 'slug', 'leather-wallet');
```

### Foreign-key constraint hints (§13.4)

```ts
import type { ConstraintHints } from '@servicecute/seed-core';

const constraints: ConstraintHints = {
  unique:    [{ path: 'users', field: 'email' }],
  notNull:   [{ path: 'users', field: 'customer.email' }],   // dotted
  foreignKey: [{
    path: 'bank_accounts', field: 'businessId', references: 'users',
  }],
};
```

Field paths use **dot notation** for nesting — `customer.email`
walks `record.data.customer.email`. The runner pre-validates each
FK with `recordExists` before the upsert; misses surface as
`E_CONSTRAINT_FK`.

## Versioning

Package spec target: **v0.5.0** for the trait surface + runner
behavior. Adapter conformance tracked separately in spec §25.
