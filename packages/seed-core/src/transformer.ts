import { Registry } from "./registry.js";
import { SeedError } from "./error.js";

/**
 * JSON shape for a transformer marker (spec §14.3). Seed code embeds
 * these in records via {@link marker}; the runner replaces them with
 * transformer output at write time.
 */
export const MARKER_TRANSFORMER_KEY = "$transformer";
export const MARKER_INPUT_KEY = "input";

export interface Transformer {
  /** Transformer name as it appears in `requires: [...]`. */
  readonly name: string;
  /** Apply the transformation. Errors → `E_TRANSFORMER_FAILED`. */
  apply(input: unknown): Promise<unknown>;
}

export type TransformerRegistry = Registry<Transformer>;

export function marker(transformer: string, input: unknown): unknown {
  return {
    [MARKER_TRANSFORMER_KEY]: transformer,
    [MARKER_INPUT_KEY]: input,
  };
}

function asMarker(value: unknown): { name: string; input: unknown } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).length !== 2) return undefined;
  const name = obj[MARKER_TRANSFORMER_KEY];
  const input = obj[MARKER_INPUT_KEY];
  if (typeof name !== "string") return undefined;
  if (!(MARKER_INPUT_KEY in obj)) return undefined;
  return { name, input };
}

/** Provenance for a marker resolution — never includes input/output (§14.6). */
export interface ResolvedMarker {
  transformer: string;
  field: string;
}

/**
 * Walk a JSON value, replacing every transformer marker with the
 * resolved output (spec §14.3). Returns the resolved value plus
 * provenance for emitting `seed.transformer.applied` events.
 */
export async function resolveMarkers(
  value: unknown,
  transformers: TransformerRegistry,
  fieldPath: string,
): Promise<{ value: unknown; applied: ResolvedMarker[] }> {
  const applied: ResolvedMarker[] = [];
  const out = await walk(value, transformers, fieldPath, applied);
  return { value: out, applied };
}

async function walk(
  value: unknown,
  transformers: TransformerRegistry,
  fieldPath: string,
  applied: ResolvedMarker[],
): Promise<unknown> {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      out.push(await walk(value[i], transformers, `${fieldPath}[${i}]`, applied));
    }
    return out;
  }
  if (typeof value === "object" && value !== null) {
    const m = asMarker(value);
    if (m) {
      const transformer = transformers.lookup(m.name);
      if (!transformer) {
        throw SeedError.coded(
          "E_TRANSFORMER_MISSING",
          `field ${JSON.stringify(fieldPath)} references transformer ${JSON.stringify(m.name)} which is not registered`,
        );
      }
      let output: unknown;
      try {
        output = await transformer.apply(m.input);
      } catch (e) {
        throw SeedError.coded(
          "E_TRANSFORMER_FAILED",
          `transformer ${JSON.stringify(m.name)} failed at field ${JSON.stringify(fieldPath)}: ${(e as Error).message}`,
          e,
        );
      }
      applied.push({ transformer: m.name, field: fieldPath });
      return output;
    }
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const childPath = fieldPath ? `${fieldPath}.${k}` : k;
      out[k] = await walk(v, transformers, childPath, applied);
    }
    return out;
  }
  return value;
}
