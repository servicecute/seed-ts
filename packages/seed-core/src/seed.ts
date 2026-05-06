import { createHash } from "node:crypto";
import { Registry } from "./registry.js";
import { SeedError } from "./error.js";

/** Stable seed identifier — `(table, key)` per spec §6.1. */
export interface SeedKey {
  table: string;
  key: string;
}

/** Optional declarative constraint hints (spec §13.4 / T14.1). */
export interface ConstraintHints {
  unique?: FieldRef[];
  notNull?: FieldRef[];
  /**
   * Foreign-key declarations (§13.4 extension). The runner pre-
   * validates each at write time using `recordExists` — catches
   * typo'd uids in id-typed fields that weren't authored as
   * `$ref` markers. Empty/omitted = no FK enforcement.
   */
  foreignKey?: ForeignKeyHint[];
}

export interface FieldRef {
  path: string;
  field: string;
}

/**
 * Foreign-key declaration: `path.field` must contain a doc key that
 * exists in the `references` table at apply time. The runner checks
 * each non-null value via `DbBackend.recordExists` and surfaces
 * violations as `E_CONSTRAINT_FK`. Targets just-written in the same
 * run pass via `paths_touched`. Compound foreign keys are out of
 * scope — declare one FK per physical field.
 */
export interface ForeignKeyHint {
  path: string;
  field: string;
  references: string;
}

/** Declarative shape of a seed (spec §4, §13.4, §14.5, §16.5). */
export interface Seed {
  name: string;
  /** Environments this seed may be applied in (§9). */
  scope: string[];
  /** Other seeds that must be applied first (§13.6). */
  dependsOn: string[];
  /** Schemas the seed reads/writes, with required versions (§16.5). */
  requiresSchemas: Record<string, string>;
  /** Transformer names this seed needs registered (§14.5). */
  requires: string[];
  /** Optional declarative constraints (§13.4). */
  constraints?: ConstraintHints;
  /**
   * Generator-backed batches for this seed (spec §17.10). Key is the
   * batch name; value declares the generator + prompt + caps. Empty
   * (omitted) for hand-authored seeds. The runner walks each entry
   * during `seed regenerate` and writes the cache file at
   * `<cacheDir>/<seed-name>/data/<batch-name>.cached.json`.
   */
  generators?: Record<string, GeneratorBinding>;
  /**
   * Identity bindings (proposed spec §25) — pair seeded data with
   * auth-side identities. Empty/omitted for seeds that don't touch
   * auth. Each entry declares an `IdentityBinding` (see
   * `./identity.ts`) that the runner resolves via the
   * `IdentityProviderRegistry` during apply, minting the uid before
   * the data write and tearing it down on reset. The whole identity
   * path is a no-op when this is empty AND no providers are
   * registered.
   */
  identities?: Record<string, import("./identity.js").IdentityBinding>;
  /** Canonical content hash for drift detection (§10.3). */
  keyHash: string;
}

/**
 * Per-seed declaration that one batch of records is produced by a
 * generator (LLM, faker, csv, …) instead of authored by hand
 * (spec §17.10).
 *
 * Mirrors the Rust `GeneratorBinding`. Field names on the wire match
 * camelCase TS conventions; the cache file's `$generator` block uses
 * snake_case for cross-language portability (see `writeCanonicalCache`
 * in `generator.ts`).
 */
export interface GeneratorBinding {
  /** Name registered in the generator registry. `E_GENERATOR_NOT_FOUND` if missing at regenerate time. */
  generator: string;
  /** Schema name from the schemas registry the records will validate against. */
  schema: string;
  /** Prompt / input text. The runner hashes this for cache-stale detection (§17.7). */
  prompt: string;
  /** Hard cap on records the generator may emit per call. */
  maxRecords: number;
  /** LLM-only: hard cap on tokens per call. */
  maxTokens?: number;
  /** Per-binding override for the hard timeout. Resolves per-binding → runner → 60_000 ms (§17.4). */
  timeoutMs?: number;
  /** Per-binding override for the validation drop ratio (0..1). Resolves per-binding → runner → 0.20 (§17.4). */
  validationThreshold?: number;
  /** Generator-specific knobs (LLM `model`/`temperature`, CSV path, …). */
  params?: unknown;
}

/** SHA-256 of arbitrary input. */
export function hashBytes(content: string | Uint8Array): string {
  const h = createHash("sha256");
  h.update(content);
  return `sha256:${h.digest("hex")}`;
}

/**
 * SHA-256 of normalized seed source per spec §19.3:
 * 1. Strip line + block comments
 * 2. Collapse whitespace runs to single space
 * 3. Trim
 * 4. Encode UTF-8
 *
 * Cross-language hash compatibility is explicitly NOT a goal (§19.3).
 */
export function hashCanonical(source: string): string {
  return hashBytes(canonicalizeSource(source));
}

function canonicalizeSource(source: string): string {
  // Strip block + line comments. Regex-grade — it does not parse
  // string literals, which is fine because the hash is for drift
  // detection on the same input file, not robustness against
  // pathological code.
  let stripped = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        i++;
      }
      i = Math.min(i + 2, source.length);
      stripped += " ";
      continue;
    }
    if (c === "/" && next === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
      stripped += " ";
      continue;
    }
    stripped += c;
    i++;
  }
  // Collapse whitespace runs.
  let canon = "";
  let lastWs = false;
  for (const ch of stripped) {
    if (/\s/.test(ch)) {
      if (!lastWs) {
        canon += " ";
        lastWs = true;
      }
    } else {
      canon += ch;
      lastWs = false;
    }
  }
  return canon.trim();
}

export type SeedRegistry = Registry<Seed>;

/** One write produced by a {@link SeedAction}. */
export interface OwnedWrite {
  table: string;
  key: string;
  data: unknown;
}

/**
 * Apply-time hook for a seed. The full runner-context API (§11.6) is
 * tracked under T13 — this interface is the minimal surface the
 * runner needs to drive `upsertBatch` from a registered action.
 */
export interface SeedAction {
  produce(): Promise<OwnedWrite[]>;
}

export type SeedActionRegistry = Registry<SeedAction>;

/** Spec §13.6: topological apply order with alphabetical tie-break. */
export function topologicalOrder(registry: SeedRegistry): string[] {
  const names = registry.names().sort();
  const indeg = new Map<string, number>();
  const deps = new Map<string, string[]>();
  for (const n of names) {
    const seed = registry.lookup(n)!;
    for (const parent of seed.dependsOn) {
      if (!names.includes(parent)) {
        throw SeedError.coded(
          "E_INTERNAL",
          `seed ${JSON.stringify(n)} depends on undeclared seed ${JSON.stringify(parent)}`,
        );
      }
      const list = deps.get(parent) ?? [];
      list.push(n);
      deps.set(parent, list);
    }
    indeg.set(n, seed.dependsOn.length);
  }
  const ready = names.filter((n) => (indeg.get(n) ?? 0) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort();
    const next = ready.shift()!;
    order.push(next);
    for (const child of deps.get(next) ?? []) {
      const d = (indeg.get(child) ?? 0) - 1;
      indeg.set(child, d);
      if (d === 0) ready.push(child);
    }
  }
  if (order.length !== names.length) {
    const unresolved = names.filter((n) => (indeg.get(n) ?? 0) > 0);
    throw SeedError.coded(
      "E_INTERNAL",
      `cycle detected in seed dependsOn graph; unresolved: ${unresolved.join(", ")}`,
    );
  }
  return order;
}

/**
 * `$ref` marker — embed in record JSON to express a cross-seed
 * reference (spec §7). The runner verifies the target exists at write
 * time and rewrites the marker into the backend's wire form.
 */
export const REF_MARKER_KEY = "$ref";

/**
 * What a `$ref` marker is asking the runner to resolve (spec §7.1).
 *
 * - `key`: direct lookup by doc key — historical default. Wire form
 *   is the path string (`table/key` Firestore, `table:key`
 *   SurrealDB).
 * - `field`: lookup by an indexed natural-key field (`email`,
 *   `slug`, …). Wire form is the bare resolved doc key —
 *   for id-typed fields that store the target's doc key verbatim.
 *   `{table, email}` is sugar for `{field: "email"}` (§25.8).
 */
export type RefTarget =
  | { kind: "key"; table: string; key: string }
  | { kind: "field"; table: string; field: string; value: string };

/** Build a `{$ref: {table, key}}` marker (path-typed wire form). */
export function refMarker(table: string, key: string): unknown {
  return { [REF_MARKER_KEY]: { table, key } };
}

/**
 * Build a `{$ref: {table, field, value}}` marker. Use for natural-key
 * cross-seed references — `email`, `slug`, `code`, `isbn`, … —
 * resolved via `DbBackend.findKeyByField` at apply time. Wire form
 * is the bare resolved key string.
 */
export function refMarkerByField(
  table: string,
  field: string,
  value: string,
): unknown {
  return { [REF_MARKER_KEY]: { table, field, value } };
}

/**
 * Sugar for {@link refMarkerByField} with `field: "email"` — emits
 * the documented 2-field shape `{table, email}` which the parser
 * desugars on read.
 */
export function refMarkerByEmail(table: string, email: string): unknown {
  return { [REF_MARKER_KEY]: { table, email } };
}

/**
 * Recognise a JSON object as a `$ref` marker (spec §7.1).
 * Accepted shapes:
 * - `{$ref: {table, key}}`               → `{kind: "key"}`
 * - `{$ref: {table, field, value}}`      → `{kind: "field"}`
 * - `{$ref: {table, email}}`             → `{kind: "field", field: "email"}`
 *   (documented sugar — other natural-key fields use the explicit
 *   3-field form)
 */
export function asRefMarker(value: unknown): RefTarget | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1 || !keys.includes(REF_MARKER_KEY)) return undefined;
  const inner = obj[REF_MARKER_KEY];
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) {
    return undefined;
  }
  const innerObj = inner as Record<string, unknown>;
  const table = innerObj["table"];
  if (typeof table !== "string") return undefined;

  switch (Object.keys(innerObj).length) {
    case 2: {
      const k = innerObj["key"];
      if (typeof k === "string") return { kind: "key", table, key: k };
      const e = innerObj["email"];
      if (typeof e === "string") {
        return { kind: "field", table, field: "email", value: e };
      }
      return undefined;
    }
    case 3: {
      const f = innerObj["field"];
      const v = innerObj["value"];
      if (typeof f !== "string" || typeof v !== "string") return undefined;
      return { kind: "field", table, field: f, value: v };
    }
    default:
      return undefined;
  }
}
