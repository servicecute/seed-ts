import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SeedError } from "./error.js";
import { Registry } from "./registry.js";
import type { SchemaEntry } from "./schema.js";

/** Token usage reported by LLM-backed generators (spec §17.1). */
export interface TokenUsage {
  prompt: number;
  completion: number;
}

export interface PricingEntry {
  promptUsd: number;
  completionUsd: number;
}

/** Pricing registry per `(provider, model)` (§17.4). */
export class PricingRegistry {
  private readonly entries = new Map<string, PricingEntry>();

  register(provider: string, model: string, entry: PricingEntry): this {
    this.entries.set(`${provider}|${model}`, entry);
    return this;
  }

  lookup(provider: string, model: string): PricingEntry | undefined {
    return this.entries.get(`${provider}|${model}`);
  }

  estimate(
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
  ): number | undefined {
    const e = this.lookup(provider, model);
    if (!e) return undefined;
    return e.promptUsd * promptTokens + e.completionUsd * completionTokens;
  }
}

export interface GeneratorContext {
  schemaName: string;
  schema: SchemaEntry;
  prompt: string;
  maxRecords: number;
  maxTokens?: number;
  timeoutMs: number;
  /** 0..=1, default 0.20 (§17.4). */
  validationThreshold: number;
  params: unknown;
}

export interface GeneratorOutput {
  records: unknown[];
  droppedCount: number;
  tokens?: TokenUsage;
  actualCostUsd?: number;
}

/** Spec §17.1 generator interface. */
export interface Generator {
  readonly name: string;
  /** USD estimate, or `undefined` when not estimable (faker, csv). */
  estimateCost(ctx: GeneratorContext): number | undefined;
  generate(ctx: GeneratorContext): Promise<GeneratorOutput>;
}

export type GeneratorRegistry = Registry<Generator>;

/**
 * Provenance metadata at the top of every cache file (spec §17.3).
 * Field names match the wire form (snake_case) so the file is
 * byte-identical to what the Rust runner writes.
 */
export interface CacheProvenance {
  name: string;
  schema: string;
  schema_version: string;
  model?: string;
  prompt_hash: string;
  generated_at: string;
  record_count: number;
  tokens?: TokenUsage;
}

/** Full cache file shape per spec §17.3. */
export interface CacheFile {
  generator: CacheProvenance;
  data: unknown[];
}

/**
 * SHA-256 of the prompt, `sha256:`-prefixed lowercase hex. Byte-
 * identical to the Rust impl's `prompt_hash`. Used for cache-stale
 * detection (spec §17.7).
 */
export function promptHash(prompt: string): string {
  const h = createHash("sha256");
  h.update(prompt, "utf8");
  return `sha256:${h.digest("hex")}`;
}

/**
 * Serialize a {@link CacheFile} with the canonical conventions from
 * spec §17.3:
 *   - 2-space indent
 *   - LF line endings
 *   - keys sorted lex inside every object inside `data` (recursive)
 *   - `$generator` keys in declaration order (the sole exception
 *     so provenance reads top-to-bottom in code review)
 *   - trailing newline at EOF
 *
 * MUST produce byte-identical output to
 * `lib_seed_core::write_canonical_cache` for the same inputs
 * (cross-language portability per §17.7). The shared fixture in
 * `canonical-cache.test.ts` enforces this contract.
 */
export function writeCanonicalCache(file: CacheFile): Buffer {
  // `data`: pre-sort every nested object's keys, then JSON.stringify
  // with 2-space indent.
  const sortedData = file.data.map(sortJsonKeys);
  const dataJson = JSON.stringify(sortedData, null, 2);

  // `$generator`: build manually in declaration order. JSON.stringify
  // on a plain object preserves insertion order in V8 / SpiderMonkey
  // / JSC for string keys, but we go manual to match Rust's manual
  // emission byte-for-byte and to skip serializing optional fields
  // when undefined.
  const prov = file.generator;
  const lines: string[] = [];
  const lit = (s: string) => JSON.stringify(s);
  lines.push(`    "name": ${lit(prov.name)}`);
  lines.push(`    "schema": ${lit(prov.schema)}`);
  lines.push(`    "schema_version": ${lit(prov.schema_version)}`);
  if (prov.model !== undefined && prov.model !== null) {
    lines.push(`    "model": ${lit(prov.model)}`);
  }
  lines.push(`    "prompt_hash": ${lit(prov.prompt_hash)}`);
  lines.push(`    "generated_at": ${lit(prov.generated_at)}`);
  lines.push(`    "record_count": ${prov.record_count}`);
  if (prov.tokens !== undefined && prov.tokens !== null) {
    const t = prov.tokens;
    lines.push(
      `    "tokens": {\n      "prompt": ${t.prompt},\n      "completion": ${t.completion}\n    }`,
    );
  }
  const generatorBlock = lines.join(",\n");

  // Re-indent every line of `dataJson` after the first by 2 spaces
  // because it's nested inside the top-level object.
  const dataIndented = dataJson
    .split("\n")
    .map((line, i) => (i === 0 || line === "" ? line : `  ${line}`))
    .join("\n");

  const out =
    `{\n  "$generator": {\n${generatorBlock}\n  },\n  "data": ${dataIndented}\n}\n`;
  return Buffer.from(out, "utf8");
}

/** Recursively sort object keys alphabetically. Arrays preserve order. */
function sortJsonKeys(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortJsonKeys);
  const obj = v as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj).sort();
  for (const k of keys) sorted[k] = sortJsonKeys(obj[k]);
  return sorted;
}

/**
 * Read the cache file for a generator-backed seed batch and return
 * its `data` array (spec §17.2). Strips the `$generator` provenance
 * block. Path: `<cacheDir>/<seedName>/data/<batchName>.cached.json`.
 *
 * Throws `E_GENERATOR_FAILED` when the file is missing or unparseable.
 * The runner's apply-side `checkGeneratorCaches` already detects these
 * conditions; this helper is for service code that wants to read
 * records directly inside `SeedAction.produce()`.
 */
export function loadGeneratedCache(
  cacheDir: string,
  seedName: string,
  batchName: string,
): unknown[] {
  return loadCacheFile(cacheDir, seedName, batchName).data;
}

/**
 * Read and parse the full cache file (provenance + data). Used
 * internally by the apply-time cache freshness check.
 */
export function loadCacheFile(
  cacheDir: string,
  seedName: string,
  batchName: string,
): CacheFile {
  const filePath = path.join(
    cacheDir,
    seedName,
    "data",
    `${batchName}.cached.json`,
  );
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    throw SeedError.coded(
      "E_GENERATOR_FAILED",
      `cache file ${filePath} unreadable: ${(e as Error).message} (run \`seed regenerate ${seedName}\`)`,
    );
  }
  let parsed: CacheFile;
  try {
    parsed = JSON.parse(raw) as CacheFile;
  } catch (e) {
    throw SeedError.coded(
      "E_GENERATOR_FAILED",
      `cache file ${filePath} parse error: ${(e as Error).message}`,
    );
  }
  // The wire form is `{ "$generator": ..., "data": ... }`. Map it to
  // our internal shape `{ generator, data }`.
  const wire = parsed as unknown as { $generator?: CacheProvenance; data?: unknown[] };
  if (!wire.$generator || !Array.isArray(wire.data)) {
    throw SeedError.coded(
      "E_GENERATOR_FAILED",
      `cache file ${filePath} missing $generator or data block`,
    );
  }
  return { generator: wire.$generator, data: wire.data };
}
