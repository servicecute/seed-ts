import type { SchemaEntry } from "@servicecute/seed-core";

/**
 * Build a {@link SchemaEntry} for a Firestore-targeted seed from a
 * plain JSON Schema 2020-12 object. Saves consumers from spelling out
 * `BackendMetadata` boilerplate at every registration site.
 *
 * See `@servicecute/surrealdb-seed`'s `schemaForSurreal` for the full
 * recipe — same TypeBox / Zod / hand-written JSON Schema patterns
 * apply.
 *
 * @example
 * ```ts
 * import { t } from "elysia";
 * import { schemaForFirestore } from "@servicecute/firestore-seed";
 *
 * const Country = t.Object({ iso: t.String(), name: t.String() });
 * config.schemas.register("countries",
 *   schemaForFirestore("countries", "1", Country));
 * ```
 */
export function schemaForFirestore(
  name: string,
  version: string,
  schema: unknown,
): SchemaEntry {
  return {
    name,
    version,
    source: "code",
    backend: { firestore: { collection: name } },
    schema,
  };
}
