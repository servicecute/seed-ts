import { describe, expect, it } from "bun:test";
import {
  type CacheFile,
  loadCacheFile,
  promptHash,
  writeCanonicalCache,
} from "../src/index.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fixture inputs that match the Rust `canonical_cache_byte_parity_fixture`
 * test verbatim. Editing either side without the other breaks the
 * cross-language byte-parity contract from spec §17.7.
 */
function fixture(): { file: CacheFile; expected: string } {
  const file: CacheFile = {
    generator: {
      name: "stub",
      schema: "users",
      schema_version: "1",
      prompt_hash: promptHash("p"),
      generated_at: "2026-01-01T00:00:00Z",
      record_count: 2,
      tokens: { prompt: 100, completion: 50 },
    },
    data: [{ a: 1, nested: { y: 2, x: 1 } }, { b: 2 }],
  };

  // Hand-built expected output to lock the wire form. If you change
  // this string, change the matching fixture in lib-seed-core's
  // `canonical_cache_byte_parity_fixture` test.
  const expected =
    `{
  "$generator": {
    "name": "stub",
    "schema": "users",
    "schema_version": "1",
    "prompt_hash": "${promptHash("p")}",
    "generated_at": "2026-01-01T00:00:00Z",
    "record_count": 2,
    "tokens": {
      "prompt": 100,
      "completion": 50
    }
  },
  "data": [
    {
      "a": 1,
      "nested": {
        "x": 1,
        "y": 2
      }
    },
    {
      "b": 2
    }
  ]
}
`;

  return { file, expected };
}

describe("writeCanonicalCache", () => {
  it("matches the cross-language byte-parity fixture", () => {
    const { file, expected } = fixture();
    const out = writeCanonicalCache(file).toString("utf8");
    expect(out).toBe(expected);
  });

  it("omits optional model and tokens when undefined", () => {
    const file: CacheFile = {
      generator: {
        name: "stub",
        schema: "users",
        schema_version: "1",
        prompt_hash: promptHash("p"),
        generated_at: "2026-01-01T00:00:00Z",
        record_count: 0,
      },
      data: [],
    };
    const out = writeCanonicalCache(file).toString("utf8");
    expect(out).not.toContain("\"model\"");
    expect(out).not.toContain("\"tokens\"");
    expect(out).toContain("\"record_count\": 0");
  });

  it("emits a stable promptHash format", () => {
    const h = promptHash("hello");
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Guard against accidental change: known SHA-256 of "hello".
    expect(h).toBe(
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("loadCacheFile", () => {
  it("round-trips a written file", () => {
    const { file } = fixture();
    const dir = mkdtempSync(join(tmpdir(), "seed-cache-"));
    try {
      const seedDir = join(dir, "demo", "data");
      mkdirSync(seedDir, { recursive: true });
      writeFileSync(
        join(seedDir, "batch1.cached.json"),
        writeCanonicalCache(file),
      );
      const loaded = loadCacheFile(dir, "demo", "batch1");
      expect(loaded.generator.name).toBe("stub");
      expect(loaded.generator.prompt_hash).toBe(file.generator.prompt_hash);
      expect(loaded.data).toEqual(file.data);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws E_GENERATOR_FAILED on a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-cache-"));
    try {
      expect(() => loadCacheFile(dir, "missing", "batch")).toThrow(
        /E_GENERATOR_FAILED/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
