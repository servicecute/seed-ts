/**
 * DDL statements for the SurrealDB tracking and lock tables — the
 * `DEFINE TABLE` / `DEFINE FIELD` / `DEFINE INDEX` SQL that creates
 * the schema for `__seeds` and `__seeds_lock`.
 *
 * Spec §10.1. The runner executes these statements idempotently on
 * `setup()` (each uses `IF NOT EXISTS`) so consumers don't need a
 * separate database migration just for seed bookkeeping.
 *
 * MUST stay byte-equivalent to the Rust workspace's
 * `lib-surrealdb-seed/src/ddl.rs` so cross-language parity tests
 * see identical schema.
 */

export const TRACKING_DDL = `
DEFINE TABLE IF NOT EXISTS __seeds SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS name                    ON TABLE __seeds TYPE string;
DEFINE FIELD IF NOT EXISTS applied_at              ON TABLE __seeds TYPE datetime;
DEFINE FIELD IF NOT EXISTS key_hash                ON TABLE __seeds TYPE string;
DEFINE FIELD IF NOT EXISTS scope                   ON TABLE __seeds TYPE array<string>;
DEFINE FIELD IF NOT EXISTS paths_touched           ON TABLE __seeds TYPE array<string>;
DEFINE FIELD IF NOT EXISTS tracking_schema_version ON TABLE __seeds TYPE string;
DEFINE FIELD IF NOT EXISTS spec_version            ON TABLE __seeds TYPE string;
DEFINE FIELD IF NOT EXISTS created_identities      ON TABLE __seeds TYPE option<array> DEFAULT [];
DEFINE INDEX IF NOT EXISTS __seeds_name_idx ON TABLE __seeds COLUMNS name UNIQUE;
`;

/**
 * `__seeds_lock` advisory-lock table per spec §10.1.
 *
 * `holder` stores a JSON-serialised `LockHolder` so the host/pid/label
 * round-trip through the `TYPE string` column without changing the
 * schema. `ttl_secs` records the holder's TTL so `current()` can
 * reconstruct `LockClaim.ttlMs`.
 *
 * The UNIQUE index on `verb` enforces the per-verb-class singleton
 * behaviour; each row's record ID is the verb itself, so the
 * constraint is structurally redundant but kept for older clients
 * that query by field rather than by ID.
 */
export const LOCK_DDL = `
DEFINE TABLE IF NOT EXISTS __seeds_lock SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS verb        ON TABLE __seeds_lock TYPE string;
DEFINE FIELD IF NOT EXISTS holder      ON TABLE __seeds_lock TYPE string;
DEFINE FIELD IF NOT EXISTS acquired_at ON TABLE __seeds_lock TYPE datetime;
DEFINE FIELD IF NOT EXISTS expires_at  ON TABLE __seeds_lock TYPE datetime;
DEFINE FIELD IF NOT EXISTS ttl_secs    ON TABLE __seeds_lock TYPE int;
DEFINE INDEX IF NOT EXISTS __seeds_lock_singleton ON TABLE __seeds_lock COLUMNS verb UNIQUE;
`;
