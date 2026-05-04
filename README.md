# seed-ts

TypeScript implementation of the **seed CLI/runner spec** at
[registry/seed-spec/seed-spec.md](https://github.com/servicecute/project-registry/blob/main/seed-spec/seed-spec.md)
(v0.4.1).

Sibling to the Rust workspace (`rust-workspace/lib-seed-*`). Both
implementations target the same portable contract; cross-language
parity is verified per spec §21 against the shared fixtures in
`seed-parity/`.

## Packages

| Package | Mirrors | Role |
|---|---|---|
| `@servicecute/seed-core` | `lib-seed-core` | Backend-agnostic core: registry primitive, NDJSON event schema, error codes, `Tracking`/`Lock`/`DbBackend` interfaces, `SeedRunner` orchestration, transformer + ref markers, schema registry round-trip, CLI surface. |
| `@servicecute/surrealdb-seed` | `lib-surrealdb-seed` | SurrealDB adapter using the official `surrealdb` npm package. |
| `@servicecute/firestore-seed` | `lib-firestore-seed` | Firestore adapter using `firebase-admin`. |

## Status

**Scaffolding only.** Every public API throws "not implemented yet" today.
See [tasks.md](./tasks.md) for the full breakdown — implementation work is
tracked in P0/P1/P2/P3 priorities mirroring the Rust workspace's playbook.

## Quick start (once implemented)

```ts
import { SeedRunner, SeedConfig } from "@servicecute/seed-core";
import { SurrealBackend } from "@servicecute/surrealdb-seed";

const backend = new SurrealBackend(db);
const config = new SeedConfig({ backend, scopeTarget: "development" });
config.seeds.register("baseline-tenants", { /* ... */ });
const runner = new SeedRunner(config);
await runner.apply([]);
```

## Running

```bash
# Install
bun install

# Typecheck
bun run typecheck

# Test
bun test

# Run a specific package's tests
bun test --filter @servicecute/seed-core
```

## Spec scoreboard

`@servicecute/seed-core` + adapters target **spec v0.4.1**. The
`Implementation scoreboard` (§24 of the spec) currently lists
`TS + SurrealDB` and `TS + Firestore` as **not started**; this repo
exists to flip them to conformant.

## License

MIT OR Apache-2.0 (same dual-licence as the Rust crates).
