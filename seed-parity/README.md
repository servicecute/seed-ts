# Seed Parity Test Suite (TypeScript)

Mirror of the Rust workspace's `seed-parity/` directory — the spec
§21 cross-implementation parity harness.

The fixtures (`countries.json`), expected post-states
(`surreal-state.surql`, `firestore-state.json`), and reference NDJSON
event sequence (`apply.events.ndjson`) **MUST** be byte-equivalent to
the Rust workspace's copies. They are the cross-language artifact
(spec §14.7).

## Layout

```
seed-parity/
  fixtures/
    countries.json           ← shared with rust-workspace/seed-parity/
  seeds/
    baseline-countries.ts    ← TS variant of the seed body
  expected/
    surreal-state.surql      ← shared with rust-workspace
    firestore-state.json     ← shared with rust-workspace
    apply.events.ndjson      ← shared with rust-workspace
```

## Running (once implementations land)

```bash
# SurrealDB parity (requires SurrealDB at SURREAL_PARITY_URL)
bun test --filter @servicecute/surrealdb-seed parity

# Firestore parity (requires emulator at FIRESTORE_EMULATOR_HOST)
bun test --filter @servicecute/firestore-seed parity
```

Today the parity tests on the TS side don't exist yet — they're
tracked as T10.x in `tasks.md`.
