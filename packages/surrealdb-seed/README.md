# @servicecute/surrealdb-seed

SurrealDB adapter for the seed runner — TypeScript port of
`lib-surrealdb-seed`. **Spec v0.4.3 conformant** today; v0.5.0
closure pending the cross-repo `@surrealdb-auth/client` wire-in
(see [tasks.md T17.1..4](../../tasks.md)).

Implements [`@servicecute/seed-core`](../seed-core/)'s `DbBackend`
against the `surrealdb` npm client, with:

- `__seeds` tracking table (spec §10.1). Optional
  `created_identities` column carries §24 identity records as a
  typed array.
- `__seeds_lock` advisory-lock table with UNIQUE on `verb` (spec
  §10.1, §10.5).
- Atomic batched upsert via `BEGIN/COMMIT TRANSACTION`.
- Path-keyed delete for `seed reset`.
- `findKeyByField` and `findUniqueConflicts` — both speak
  SurrealDB nested-field syntax for dotted paths (§13.4 ext).

## Install

```bash
bun add @servicecute/surrealdb-seed @servicecute/seed-core surrealdb
```

## Usage

```ts
import { Surreal } from 'surrealdb';
import { SeedConfig, SeedRunner } from '@servicecute/seed-core';
import { SurrealBackend } from '@servicecute/surrealdb-seed';

const db = new Surreal();
await db.connect('ws://localhost:8000', { /* ... */ });
const backend = new SurrealBackend(db);
const config = new SeedConfig({ backend, scopeTarget: 'development' });
// register schemas, transformers, generators, seeds...
const runner = new SeedRunner(config);
await runner.apply([]);
```

### With surreal-auth identities (§24, deferred)

The Rust-side adapter ships
(`@surrealdb-auth/client`'s `SurrealAuthIdentityProvider`) and the
runner integration on this side is in place. What's outstanding:

- Publish `@surrealdb-auth/client` to npm or `file:`-link it from
  the rust-workspace path.
- Document the test-time bootstrap recipe for `srv-surrealdb-auth`
  (see `srv-surrealdb-auth/tasks.md` T-IDENTITY-PARITY-1).
- Run the cross-language parity scenarios end-to-end against a
  bootstrapped service.

Tracked in [tasks.md T17.1..4](../../tasks.md). Once green, this
package's spec scoreboard row flips to v0.5.0 conformant.

## Parity tests

Baseline (countries) parity runs today against any reachable
SurrealDB:

```bash
PARITY=1 \
  SURREAL_PARITY_URL=ws://localhost:8000 \
  bun test test/parity.test.ts
```

Identity-parity scenarios (§24) are deferred — see above.
