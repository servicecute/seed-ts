import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Registry } from "./registry.js";
import { SeedError } from "./error.js";

/** Where a schema entry came from. */
export type SchemaSource = "code" | "file";

/** Per-backend metadata (spec §16.1). */
export interface BackendMetadata {
  surrealdb?: { table: string; mode?: "schemafull" | "schemaless" };
  firestore?: { collection: string };
}

export interface SchemaEntry {
  name: string;
  version: string;
  source: SchemaSource;
  backend: BackendMetadata;
  /** JSON Schema 2020-12. */
  schema: unknown;
}

export type SchemaRegistry = Registry<SchemaEntry>;

/** Spec §16.7 cross-language wire form. */
export interface SchemaRegistryDoc {
  registry_version: string;
  entries: Record<
    string,
    {
      schema_version: string;
      backend: BackendMetadata;
      schema: unknown;
    }
  >;
}

export function registryToJson(reg: SchemaRegistry): string {
  const entries: SchemaRegistryDoc["entries"] = {};
  for (const name of reg.names()) {
    const entry = reg.lookup(name)!;
    entries[name] = {
      schema_version: entry.version,
      backend: entry.backend,
      schema: entry.schema,
    };
  }
  const doc: SchemaRegistryDoc = {
    registry_version: "0.4.1",
    entries,
  };
  return JSON.stringify(doc, null, 2);
}

export function registryFromJson(raw: string): SchemaRegistry {
  const doc = JSON.parse(raw) as SchemaRegistryDoc;
  const reg = new Registry<SchemaEntry>();
  for (const [name, entry] of Object.entries(doc.entries)) {
    reg.register(name, {
      name,
      version: entry.schema_version,
      source: "file",
      backend: entry.backend,
      schema: entry.schema,
    });
  }
  return reg;
}

/**
 * Validate `record` against `entry.schema` using AJV's draft-2020-12
 * vocabulary (spec §16.5). First failure is surfaced as
 * `E_CONSTRAINT_TYPE`.
 */
export function validateRecord(entry: SchemaEntry, record: unknown): void {
  const validator = compile(entry);
  if (!validator(record)) {
    const err = validator.errors?.[0];
    const path = err?.instancePath ?? "";
    const msg = err?.message ?? "validation failed";
    throw SeedError.coded(
      "E_CONSTRAINT_TYPE",
      `schema ${JSON.stringify(entry.name)}: record violates constraint at ${path}: ${msg}`,
    );
  }
}

/** Pre-compile a schema for repeated validation. */
export function compile(entry: SchemaEntry): ValidateFunction {
  const ajv = new Ajv2020({ strict: false, allErrors: false });
  addFormats(ajv);
  try {
    return ajv.compile(entry.schema as object);
  } catch (e) {
    throw SeedError.coded(
      "E_INTERNAL",
      `schema ${JSON.stringify(entry.name)}: invalid JSON Schema 2020-12 definition: ${(e as Error).message}`,
      e,
    );
  }
}
