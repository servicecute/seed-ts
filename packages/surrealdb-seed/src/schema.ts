import type { SchemaEntry } from "@servicecute/seed-core";

/**
 * Build a {@link SchemaEntry} for a SurrealDB-targeted seed from a
 * plain JSON Schema 2020-12 object. Saves consumers from spelling out
 * `BackendMetadata` boilerplate at every registration site.
 *
 * Works directly with **TypeBox / elysia `t`** schemas — they already
 * produce JSON Schema 2020-12. For Zod, convert with
 * `zod-to-json-schema` (separate peer dep) before passing in.
 *
 * @example TypeBox / elysia `t`
 * ```ts
 * import { t } from "elysia";
 * import { schemaForSurreal } from "@servicecute/surrealdb-seed";
 *
 * const Country = t.Object({
 *   iso: t.String({ minLength: 2, maxLength: 2 }),
 *   name: t.String(),
 * });
 * config.schemas.register("countries",
 *   schemaForSurreal("countries", "1", Country));
 * ```
 *
 * @example zod
 * ```ts
 * import { z } from "zod";
 * import { zodToJsonSchema } from "zod-to-json-schema";
 * import { schemaForSurreal } from "@servicecute/surrealdb-seed";
 *
 * const Country = z.object({ iso: z.string(), name: z.string() });
 * config.schemas.register("countries",
 *   schemaForSurreal("countries", "1", zodToJsonSchema(Country)));
 * ```
 */
export function schemaForSurreal(
  name: string,
  version: string,
  schema: unknown,
  mode: "schemafull" | "schemaless" = "schemafull",
): SchemaEntry {
  return {
    name,
    version,
    source: "code",
    backend: { surrealdb: { table: name, mode } },
    schema,
  };
}
