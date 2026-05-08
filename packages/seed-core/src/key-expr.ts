import { createHash } from "node:crypto";
import { SeedError } from "./error.js";

/**
 * Templated doc keys (seed-spec §26 v0.6.1). A seed can register a
 * {@link KeyExpr} for a record whose final doc id depends on values
 * that only exist after `$ref` resolution and identity binding (e.g.
 * a link-table row whose id is `sha256(groupId || userId)` where
 * `userId` is the minted Firebase uid).
 *
 * ## Pipeline order
 *
 * The runner applies templates after `$ref` resolution and identity
 * binding finish populating `record.data`, and before FK / unique /
 * schema pre-checks see the record:
 *
 * ```text
 *   produce → identity binding → transformers → $ref resolution
 *     → KEY TEMPLATE  ← new step
 *     → FK / unique / schema → upsertBatch → tracking
 * ```
 *
 * ## Limitations
 *
 * - Cross-references to a templated record via `{$ref: {table, key}}`
 *   resolve against the placeholder key, not the final hash, so they
 *   won't find the row. `$ref` by field
 *   (`{$ref: {table, field, value}}`) still works because field
 *   lookup queries the backend post-write.
 * - If a record has both an identity binding with `keyFromUid: true`
 *   and a key template, the template wins (it runs later).
 * - `DataPath` parts MUST resolve to JSON strings. Numbers / null /
 *   objects / arrays fail with `E_KEY_TEMPLATE_FAILED` because the
 *   byte representation isn't well-defined for them.
 */

export type KeyExpr = Sha256HexKeyExpr;

/**
 * `format!("{prefix}{lowercase_hex(sha256(parts.bytes_concat()))}")`.
 * Parts are concatenated in declaration order before hashing — matches
 * the typical `sha256(field_a || field_b)` natural-key pattern used
 * for link tables.
 */
export interface Sha256HexKeyExpr {
  readonly kind: "sha256_hex";
  readonly prefix: string;
  readonly parts: readonly KeyPart[];
}

export type KeyPart = LiteralKeyPart | DataPathKeyPart;

/** UTF-8 bytes of a literal string. */
export interface LiteralKeyPart {
  readonly source: "literal";
  readonly value: string;
}

/**
 * JSON Pointer (RFC 6901) into the record's `data`. The pointed
 * value MUST be a string at apply time.
 */
export interface DataPathKeyPart {
  readonly source: "data_path";
  readonly pointer: string;
}

/** RFC 6901 JSON Pointer evaluator. Returns `undefined` on miss. */
function jsonPointerGet(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) {
    throw SeedError.coded(
      "E_KEY_TEMPLATE_FAILED",
      `KeyExpr DataPath pointer ${JSON.stringify(pointer)} must start with "/"`,
    );
  }
  const tokens = pointer
    .slice(1)
    .split("/")
    .map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"));
  let cursor: unknown = value;
  for (const token of tokens) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length) {
        return undefined;
      }
      cursor = cursor[idx];
    } else if (typeof cursor === "object") {
      cursor = (cursor as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return cursor;
}

/**
 * Apply a key template against a fully resolved `record.data`. Errors
 * with `E_KEY_TEMPLATE_FAILED` when a `DataPath` is missing,
 * non-string, or `parts` is empty.
 */
export function applyKeyExpr(expr: KeyExpr, data: unknown): string {
  switch (expr.kind) {
    case "sha256_hex": {
      if (expr.parts.length === 0) {
        throw SeedError.coded(
          "E_KEY_TEMPLATE_FAILED",
          "KeyExpr Sha256Hex requires at least one part",
        );
      }
      const hasher = createHash("sha256");
      for (const part of expr.parts) {
        switch (part.source) {
          case "literal":
            hasher.update(part.value, "utf8");
            break;
          case "data_path": {
            const value = jsonPointerGet(data, part.pointer);
            if (value === undefined) {
              throw SeedError.coded(
                "E_KEY_TEMPLATE_FAILED",
                `KeyExpr DataPath ${JSON.stringify(part.pointer)} not found in record.data`,
              );
            }
            if (typeof value !== "string") {
              throw SeedError.coded(
                "E_KEY_TEMPLATE_FAILED",
                `KeyExpr DataPath ${JSON.stringify(part.pointer)} resolved to non-string ${JSON.stringify(value)}`,
              );
            }
            hasher.update(value, "utf8");
            break;
          }
          default: {
            const _exhaustive: never = part;
            void _exhaustive;
            throw SeedError.coded(
              "E_KEY_TEMPLATE_FAILED",
              `unknown KeyPart source: ${JSON.stringify(part)}`,
            );
          }
        }
      }
      return `${expr.prefix}${hasher.digest("hex")}`;
    }
    default: {
      const _exhaustive: never = expr.kind;
      void _exhaustive;
      throw SeedError.coded(
        "E_KEY_TEMPLATE_FAILED",
        `unknown KeyExpr kind: ${JSON.stringify(expr)}`,
      );
    }
  }
}
