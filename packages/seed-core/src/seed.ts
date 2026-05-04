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
}

export interface FieldRef {
  path: string;
  field: string;
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
  /** Canonical content hash for drift detection (§10.3). */
  keyHash: string;
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

export function refMarker(table: string, key: string): unknown {
  return { [REF_MARKER_KEY]: { table, key } };
}

export function asRefMarker(value: unknown): { table: string; key: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1 || !keys.includes(REF_MARKER_KEY)) return undefined;
  const inner = obj[REF_MARKER_KEY];
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return undefined;
  const innerObj = inner as Record<string, unknown>;
  if (Object.keys(innerObj).length !== 2) return undefined;
  const table = innerObj["table"];
  const key = innerObj["key"];
  if (typeof table !== "string" || typeof key !== "string") return undefined;
  return { table, key };
}
