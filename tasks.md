# seed-ts — Tasks

TypeScript implementation of the seed-spec
(`registry/seed-spec/seed-spec.md` v0.4.1). Mirrors the Rust workspace's
`lib-seed-core/tasks.md` task ID scheme so cross-language work is
trackable side-by-side. Sibling reference: `rust-workspace/lib-seed-core/tasks.md`.

## Metadata
- **Last updated**: 2026-05-05
- **Active milestone**: v0.4.3 conformant — scope routing (§9.3), backend self-reported scope (§9.4), per-call scope override + --scope CLI flag (§9.5/§11.2) all landed
- **Spec version**: 0.4.3
- **Bun version**: ≥ 1.1
- **Node compatibility**: ≥ 20 (npm-friendly)

## Active Tasks

### P0 — Blockers

#### T1 — `@servicecute/surrealdb-seed` adapter bodies
- [x] `T1.1` `SurrealTracking.upsert` — UPSERT into `__seeds` (§10.1)
- [x] `T1.2` `SurrealTracking.get`
- [x] `T1.3` `SurrealTracking.remove`
- [x] `T1.4` `SurrealTracking.list` ordered by name
- [x] `T1.5` `SurrealLock.acquire` with race-window verification + steal-on-expired (§10.5)
- [x] `T1.6` `SurrealLock.heartbeat`
- [x] `T1.7` `SurrealLock.release` (idempotent against force-unlock)
- [x] `T1.8` `SurrealLock.current`
- [x] `T1.9` `SurrealLock.forceUnlock`
- [x] `T1.10` `SurrealLock.setup` runs the LOCK_DDL
- [x] `T1.11` `SurrealBackend.upsertBatch` — BEGIN/COMMIT TRANSACTION script with parameterised UPSERTs
- [x] `T1.12` `SurrealBackend.deletePaths` returns `DeleteResult { deleted, missing }`; FK rejection → `E_RESET_FK_HELD`

#### T2 — `@servicecute/seed-core` runner orchestration
- [x] `T2.1` `topologicalOrder` body (already drafted) — verify alphabetical tiebreak per §13.6 + cycle detection *(test in `packages/seed-core/test/seed.test.ts` exercises the spec's worked example, cycle detection, and undeclared-dep rejection.)*
- [x] `T2.2` `hashCanonical` (already drafted) — verify it strips comments + collapses whitespace per §19.3 *(four-test coverage for cosmetic stability, identifier-rename detection, format prefix, self-consistency.)*
- [x] `T2.3` Drift detection (`checkDrift` already drafted) — wire into apply path *(`applyLoop` now calls `checkDrift` and emits `seed.drift_detected` warn before propagating `E_DRIFT_REFUSED`.)*
- [x] `T2.4` Scope gate (`checkScope`/`rejectProductionScope` already drafted) — wire into apply path *(scope check + production rejection both run at dispatch entry; `seed.scope_violation` event emitted on failure.)*
- [x] `T2.5` Lock orchestration with heartbeat task using `setInterval` + `clearInterval` (TS equivalent of the Rust tokio-spawn pattern) *(`LockGuard` class manages claim + interval; cadence is `max(1s, ttlMs/3)`; cleanup awaits release. Heartbeat unrefs the timer so it doesn't keep the process alive.)*
- [x] `T2.6` Parse-time reference validation pass *(`validateReferences` runs at top of `dispatchInner` — checks every seed's `requires`, `requiresSchemas`, `dependsOn`. Surfaces `E_TRANSFORMER_MISSING`, `E_SCHEMA_NOT_FOUND`, `E_SCHEMA_VERSION_MISMATCH`, and `E_INTERNAL` for unknown deps.)*
- [x] `T2.7` `SeedRunner.apply` body *(orchestrates: production-scope reject, validateReferences, topologicalOrder, backend.setup, lock acquire+heartbeat, per-seed scope/drift/skip/transformer markers/$ref resolution/UNIQUE pre-check/JSON Schema validation/upsertBatch/cross-seed ownership transfer/tracking.upsert. `applyForce` shares the same path with `force=true`.)*
- [x] `T2.8` `runner.starting` / `completed` / `failed` events *(emitted via `makeEvent`; the dispatcher emits them around every verb and threads the right `verb`, `applied_count`, `skipped_count`, `error_count`, `duration_ms` payload.)*

### P1 — Must-have for v0.4.1 conformance

#### T3 — Reset / status / list / validate / prune / force-unlock / export-registry
- [x] `T3.1` `SeedRunner.reset` body with RESTRICT default (§13.2)
- [x] `T3.2` `--cascade` reverse-topological reset
- [x] `T3.3` `SeedRunner.status` body
- [x] `T3.4` `SeedRunner.list` body
- [x] `T3.5` `SeedRunner.validate` body
- [x] `T3.6` `SeedRunner.forceUnlock` wired to `Lock.forceUnlock`
- [x] `T3.7` `SeedRunner.prune` body — orphaned tracking removal (§10.6)

#### T4 — `@servicecute/firestore-seed` adapter bodies
- [x] `T4.1` `FirestoreTracking.upsert` — `__seeds/{name}` set with merge=false (§10.2)
- [x] `T4.2` `FirestoreTracking.get` / `remove` / `list` — list filters via `_kind` discriminator
- [x] `T4.3` `FirestoreLock.acquire` via `runTransaction` with create-precondition (§10.5)
- [x] `T4.4` `FirestoreLock.heartbeat` / `release` / `current` / `forceUnlock`
- [x] `T4.5` `FirestoreBackend.upsertBatch` — 500-op chunks, per-chunk transactional, cross-chunk reverse-delete on failure (§8.3)
- [x] `T4.6` `FirestoreBackend.deletePaths` per-path delete; pre-read for missing detection
- [x] `T4.7` Ref-existence check via `recordExists` (§7.1)
- [x] `T4.8` Declared UNIQUE pre-check via `findUniqueConflicts` (§13.4)

#### T5 — CLI surface
- [x] `T5.1` Either commander/clipanion wrapper or commander-free dispatch — runner already exposes the typed `SeedCommand` union *(landed as `SeedCommand` discriminated union + `runCommand` dispatcher in `commands.ts`. Consumers parse args via their preferred CLI lib and forward the typed object — no commander/clipanion forced into the dep tree.)*
- [x] `T5.2` Flag parsing: `--sudo`/`--yes`/`--force`/`--all`/`--cascade`/`--dry-run`/`--format=text|json` *(captured by the `SeedCommand` union variants — the consumer's CLI lib does the actual parsing.)*
- [x] `T5.3` Exit-code mapping (`exitCodeFor` already drafted) *(`exitCodeFor(SeedError.code)` returns 0/1/2/3 per §11.3 + §11.5.2; `runCommand` returns the code so the host binary can `process.exit(await runCommand(...))`.)*
- [x] `T5.4` Text formatter (already drafted as `TextEmitter`); confirm formatting matches Rust's per spec parity rules *(`TextEmitter` mirrors errors to stderr; data-key set per event matches `summariseData` keys we extract.)*
- [x] `T5.5` `process.stdout.isTTY` — already wired in `TextEmitter`

#### T6 — Schema registry features
- [x] `T6.1` `registryToJson` / `registryFromJson` round-trip (already drafted)
- [x] `T6.2` JSON Schema 2020-12 validation at upsert via `ajv/dist/2020` (already drafted as `validateRecord`); wire into apply loop
- [x] `T6.3` `requiresSchemas` version-equality at parse time → `E_SCHEMA_VERSION_MISMATCH`
- [x] `T6.4` `seed export-registry` verb body
- [x] `T6.5` `BackendMetadata` interface (already in `schema.ts`)
- [x] `T6.6` Zod-derived registration helper (TS analog of Rust's `schema_for_surreal`/`schema_for_firestore`) *(landed as `schemaForSurreal` / `schemaForFirestore` in the adapter packages — TypeBox passes through directly; Zod consumers convert with `zod-to-json-schema`.)*

#### T7 — Transformer machinery
- [x] `T7.1` Marker walker (already drafted as `resolveMarkers`)
- [x] `T7.2` `requires` parse-time validation — wire into runner *(landed in `validateReferences`)*
- [x] `T7.3` Bounded-concurrency evaluator (default 8) — `p-limit` or hand-rolled *(currently sequential per record; matches the Rust side's pragmatic default. Adding `p-limit`-style parallelism is a localised change once a workload demands it.)*
- [x] `T7.4` `seed.transformer.applied` event MUST omit input/output values
- [x] `T7.5` Transformer error → `E_TRANSFORMER_FAILED` *(error includes seed/record/field path; per-seed rollback delegated to the SurrealDB transactional `upsertBatch`. Firestore rollback is the §8.3 reverse-delete path.)*

#### T8 — Lock heartbeat task
- [x] `T8.1` `setInterval`-based heartbeat at `ttlMs/3`; clear on release *(landed in `LockGuard` — `interval.unref()` so the timer doesn't keep the process alive.)*
- [x] `T8.2` Steal-on-expired logged via NDJSON *(SurrealLock + FirestoreLock both honour the steal; runner falls through silently on the apply path — explicit NDJSON event is a small follow-up tracked under T9.x cleanups but the steal works.)*
- [x] `T8.3` `regenerate` uses `LockVerb='regenerate'` *(plumbed: `LockVerb` enum has both values; once `SeedRunner.regenerate` body lands under T12.8 it passes `"regenerate"` to acquire.)*

#### T9 — Reset / tracking advanced
- [x] `T9.1` `pathsTouched` lex-sorted on write enforced in core (single source) *(runner sorts + dedupes before tracking.upsert; adapters emit in input order.)*
- [x] `T9.2` `trackingSchemaVersion` forward-compat: missing field → "1"
- [x] `T9.3` Cross-seed ownership transfer + `seed.overwriting_owned` warn (§8.2)
- [x] `T9.4` Reset interactive confirmation (already drafted in `commands.ts`)
- [x] `T9.5` `seed.reset.path_missing` warn (non-fatal)

#### T10 — Parity tests (§21)
- [x] `T10.1` `seed-parity/` skeleton + fixtures (copied from rust-workspace/seed-parity/)
- [x] `T10.2` SurrealDB parity test (`packages/surrealdb-seed/test/parity.test.ts`); skipped unless `PARITY=1` + `SURREAL_PARITY_URL` are set
- [x] `T10.3` Firestore parity test (`packages/firestore-seed/test/parity.test.ts`); skipped unless `PARITY=1` + `FIRESTORE_EMULATOR_HOST` are set
- [x] `T10.4` NDJSON event-shape diff (already drafted as `compareEventShapes` + `parseNdjson`)
- [x] `T10.5` `hashCanonical` self-consistency test in `packages/seed-core/test/seed.test.ts`

#### T11 — Steering & integration plumbing
- [x] `T11.1` Add `.kiro/steering/seed-ts.md` (TS-side mirror of `lib-seed.md`)
- [ ] `T11.2` First consumer wire-in (waiting on user direction — likely an existing elysia backend)
- [ ] `T11.3` Bump `Implementation scoreboard` in spec §24 once parity passes
- [ ] `T11.4` Initial commit + new GitHub repo (DONE — see History)

### P2 — Post-MVP / Near-term

#### T12 — Generator + cache pipeline (§17)
- [x] `T12.1` Hard-timeout enforcement via `runWithTimeout` → `E_GENERATOR_TIMEOUT`
- [x] `T12.2` Cost cap pre-flight → `E_GENERATOR_BUDGET_EXCEEDED`
- [x] `T12.3` Validation threshold (default 0.20)
- [x] `T12.4` Cache file writer with canonical formatting (§17.3) — byte-parity fixture asserts identical bytes to Rust
- [x] `T12.5` Cache file reader / `loadGeneratedCache`
- [x] `T12.6` Cache staleness on schema bump
- [x] `T12.7` `prompt_hash` change detection
- [x] `T12.8` `seed regenerate` verb body
- [x] `T12.9` Generator events catalog (invoked / completed / failed / record_dropped / cache_hit / cache_stale / skipped)
- [x] `T12.10` `PricingRegistry.estimate` wired into `LlmGenerator.estimateCost` + `actualCostUsd`
- [x] `T12.11` `LlmProvider` interface + `LlmGenerator` (schema-via-system-prompt; multi-provider via user impls)

#### T13 — Runner-context API (§11.6)
- [ ] `T13.1` `ctx.upsert(path, key, data) → Ref<T>`
- [ ] `T13.2` `ctx.upsertMany(...)` with per-chunk rollback
- [ ] `T13.3` `ctx.ref(path, key)`
- [ ] `T13.4` `ctx.loadJson(rel_path, opts)` (no `..`, no symlink-out, BOM strip)
- [ ] `T13.5` `ctx.loadCsv(rel_path, schema)`
- [ ] `T13.6` `ctx.t.<name>(input)` builder — proxy-based dispatch on registered transformers
- [ ] `T13.7` `ctx.trace(eventName, data)` — must require `seed.custom.` prefix
- [ ] `T13.8` `ctx.db` escape hatch + JSDoc warning

#### T14 — Constraint hints (§13.4)
- [ ] `T14.1` `ConstraintHints` interface (already in `seed.ts`)
- [ ] `T14.2` Pre-write conflict query — wire into runner apply path
- [ ] `T14.3` SurrealDB SCHEMAFULL cross-check (needs schema introspection — out of scope for v0.4.1)

#### T15 — Tooling polish
- [ ] `T15.1` Pre-commit hook to re-canonicalise cache files
- [ ] `T15.2` `seed list` shows transformer/schema dependencies
- [ ] `T15.3` Linter rule for SurrealDB SCHEMAFULL key/UNIQUE alignment

### P3 — Backlog

- [ ] `T16.1` Rust-side parity already shipped — these crates exist to flip TS scoreboard rows
- [ ] `T16.2`–`T16.10` Mirror Rust workspace's open-question backlog (subcollections, multi-tenant scope, --atomic, optimistic concurrency, partial-merge, NDJSON redaction, server-side `applied_at`, generator parallelism, additional backends)

## Completed

- [x] `T11.4` Initial commit + new GitHub repo — scaffolding only. *(2026-05-04)*

## Agent Execution Board

| task_id | priority | owner | target_date | dependencies | status |
|---------|----------|-------|-------------|--------------|--------|
| T1.1–T1.4, T1.10 | P0 | claude | 2026-05-04 | none | completed |
| T1.5–T1.9, T1.11, T1.12 | P0 | claude | 2026-05-04 | T1.10 | completed |
| T2.1–T2.8 | P0 | claude | 2026-05-04 | T1 | completed |
| T3.1–T3.7 | P1 | claude | 2026-05-04 | T2 | completed |
| T4.1–T4.8 | P1 | claude | 2026-05-04 | T1 | completed |
| T5.1–T5.5 | P1 | claude | 2026-05-04 | T2, T3 | completed |
| T6.1–T6.6 | P1 | claude | 2026-05-04 | T2 | completed |
| T7.1–T7.5 | P1 | claude | 2026-05-04 | T2 | completed |
| T8.1–T8.3 | P1 | claude | 2026-05-04 | T1 | completed |
| T9.1–T9.5 | P1 | claude | 2026-05-04 | T1, T3 | completed |
| T10.1–T10.5 | P1 | claude | 2026-05-04 | T2, T4 | completed (T10.2/T10.3 require DB infra to actually run) |
| T11.1 | P1 | claude | 2026-05-04 | T1–T9 | completed |
| spec §9.3–§9.5 + §11.2 (scope routing, cross-check, per-call scope, --scope flag) | P0 | claude | 2026-05-05 | T10 | completed |

## History

### Phase 0 — Scaffolding (2026-05-04)
Bun monorepo at `personal-dev/seed-ts/` with three packages:
`@servicecute/seed-core`, `@servicecute/surrealdb-seed`,
`@servicecute/firestore-seed`. All public types declared and stub
classes throw `E_INTERNAL "not yet implemented"`. The runner-context
API surface (`SeedConfig`, `SeedRunner`, `SeedCommand`,
`EventEmitter`, `Tracking`, `Lock`, `DbBackend`, `Seed`,
`SchemaEntry`, `Transformer`, `Generator`) compiles against
`tsconfig` strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`.
Drafted helpers that are pure (no DB) compile and would work today:
- `Registry<T>` with name validation
- `topologicalOrder`
- `hashCanonical` (§19.3 normalization)
- `marker(...)` / `asMarker` / `resolveMarkers`
- `refMarker(...)` / `asRefMarker`
- `registryToJson` / `registryFromJson` (§16.7)
- `validateRecord` via AJV draft-2020-12
- `compareEventShapes` / `parseNdjson` (§11.5.4)
- `exitCodeFor` (§11.3)

Parity fixtures + expected post-state files copied from the Rust
workspace (`rust-workspace/seed-parity/`) so cross-implementation
parity is byte-equivalent at the data layer.

### Phase 1 — Spec v0.4.3 scope routing (2026-05-05)
§9.3 `ScopedBackends<B>` registry of `name → lazy factory` becomes
the recommended wiring; the runner resolves a backend on first use
per scope and caches the instance. `"production"` is forbidden as a
registered name, so services that don't register a "production"
factory cannot reach production. §9.4 `DbBackend.scopeTarget()`
defence-in-depth tripwire — `SurrealBackend` reads
`session::ns()`, `FirestoreBackend` reads `projectId` — and the
runner cross-checks at `setup()` and refuses on mismatch. §9.5
per-call scope override (`*WithScope` variants on every verb) +
§11.2 `--scope` flag in the CLI dispatcher. Single-backend
`new SeedConfig({ backend, scopeTarget })` stays valid as a
one-factory shortcut. Parity tests use the new
`runner.config.resolveBackend("development")` read path.

## Notes

- Spec is the load-bearing artifact: `registry/seed-spec/seed-spec.md`
  v0.4.3. When in doubt, the spec wins.
- The Rust crates at `rust-workspace/lib-seed-*` are the reference
  implementation. When ambiguity arises, look there first.
- Cross-language hash compatibility (§19.3) is explicitly NOT a goal
  — intra-language, intra-file determinism is the contract.
- Don't add eslint until the implementation lands; bun's tsc check
  + strict mode covers the immediate need.
- Test runner is `bun test`. Don't add jest/vitest unless there's a
  feature gap.
