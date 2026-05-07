# @servicecute/firestore-seed

Firestore adapter for the seed runner — TypeScript port of
`lib-firestore-seed`. **Spec v0.5.0 conformant.**

Implements [`@servicecute/seed-core`](../seed-core/)'s `DbBackend`
against the `firebase-admin` Node SDK, with:

- `__seeds/{name}` tracking documents (spec §10.2). Optional
  `created_identities` field carries §24 identity records.
- `__seeds/_lock_apply` and `__seeds/_lock_regenerate` lock documents
  acquired via Firestore transactions (spec §10.2, §10.5).
- 500-op-chunked batched writes for `upsertBatch`.
- Document-path-keyed delete for `seed reset`.
- `findKeyByField` for §7.1 by-field `$ref` resolution.
- `findUniqueConflicts` for §13.4 `unique` pre-checks.
- **`FirebaseAdminIdentityProvider`** — wraps `firebase-admin`'s
  `auth()` surface to satisfy `IdentityProvider` (§24).

## Install

```bash
bun add @servicecute/firestore-seed @servicecute/seed-core firebase-admin
```

## Usage

```ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { SeedConfig, SeedRunner } from '@servicecute/seed-core';
import { FirestoreBackend } from '@servicecute/firestore-seed';

initializeApp({ projectId: 'my-project' });
const db = getFirestore();
const backend = new FirestoreBackend(db);
const config = new SeedConfig({ backend, scopeTarget: 'development' });
// register schemas, transformers, generators, seeds...
const runner = new SeedRunner(config);
await runner.apply([]);
```

### With Firebase Auth identities (§24)

Pair seeded user records with Firebase Auth identities via the
shipped `FirebaseAdminIdentityProvider`:

```ts
import { initializeApp } from 'firebase-admin/app';
import {
  FirestoreBackend,
  FirebaseAdminIdentityProvider,
} from '@servicecute/firestore-seed';
import { SeedConfig } from '@servicecute/seed-core';

const app = initializeApp({ projectId: 'my-project' });
const provider = new FirebaseAdminIdentityProvider({ app });

const config = new SeedConfig({ /* ... */ });
config.identityProviders.register('firebase', provider);
// register seeds with `identities` blocks declared on them...
```

Emulator support is automatic — `firebase-admin` honours
`FIREBASE_AUTH_EMULATOR_HOST` and routes to the emulator without
service-account credentials.

## Parity tests

Run via:

```bash
PARITY=1 \
  FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
  FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
  FIRESTORE_PARITY_PROJECT=development \
  bun test test/parity.test.ts
```

Covers baseline countries (apply + reset) plus paired identity-data
lifecycle and `foreign_key` hint enforcement (§24, §13.4 ext) — 4
tests total. Cross-language with `lib-firestore-seed`'s parity
suite (same fixtures, same wire output, same emulators).
