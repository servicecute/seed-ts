import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CacheFile,
  type DbBackend,
  type DeleteResult,
  type Generator,
  type GeneratorContext,
  type GeneratorOutput,
  type Lock,
  type LockClaim,
  type LockHolder,
  type LockVerb,
  loadCacheFile,
  promptHash,
  ScopedBackends,
  SeedConfig,
  SeedError,
  SeedRunner,
  type SchemaEntry,
  type Tracking,
  type TrackingEntry,
  type WriteRequest,
  type WriteResult,
  hashCanonical,
  type Seed,
} from "../src/index.js";

/** Schema accepts `{ name: string }`. */
const personSchema: SchemaEntry = {
  name: "person",
  version: "1",
  source: "code",
  backend: { surrealdb: { table: "person" } },
  schema: {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
    additionalProperties: false,
  },
};

class StubGenerator implements Generator {
  readonly name = "stub";
  constructor(
    private readonly records: unknown[],
    private readonly tokens?: { prompt: number; completion: number },
    private readonly costUsd?: number,
  ) {}
  estimateCost(_: GeneratorContext): number | undefined {
    return this.costUsd;
  }
  async generate(_: GeneratorContext): Promise<GeneratorOutput> {
    return {
      records: this.records,
      droppedCount: 0,
      tokens: this.tokens,
      actualCostUsd: this.costUsd,
    };
  }
}

class HangingGenerator implements Generator {
  readonly name = "hang";
  estimateCost(): number | undefined {
    return undefined;
  }
  generate(_: GeneratorContext): Promise<GeneratorOutput> {
    return new Promise(() => {
      /* never resolves */
    });
  }
}

/** Minimal in-memory backend so apply() can run end-to-end. */
class MemoryTracking implements Tracking {
  private readonly entries = new Map<string, TrackingEntry>();
  async setup(): Promise<void> {}
  async list(): Promise<TrackingEntry[]> {
    return Array.from(this.entries.values());
  }
  async lookup(name: string): Promise<TrackingEntry | undefined> {
    return this.entries.get(name);
  }
  async upsert(entry: TrackingEntry): Promise<void> {
    this.entries.set(entry.name, entry);
  }
  async remove(name: string): Promise<void> {
    this.entries.delete(name);
  }
}
class MemoryLock implements Lock {
  async setup(): Promise<void> {}
  async acquire(
    _verb: LockVerb,
    holder: LockHolder,
    _ttlMs: number,
  ): Promise<LockClaim> {
    return {
      verb: _verb,
      holder,
      acquiredAt: new Date().toISOString(),
      ttlMs: _ttlMs,
      lease: "memory",
    };
  }
  async release(_claim: LockClaim): Promise<void> {}
  async forceUnlock(_verb: LockVerb): Promise<void> {}
  async peek(_verb: LockVerb): Promise<LockClaim | undefined> {
    return undefined;
  }
}
class MemoryBackend implements DbBackend {
  private readonly t = new MemoryTracking();
  private readonly l = new MemoryLock();
  tracking(): Tracking {
    return this.t;
  }
  lock(): Lock {
    return this.l;
  }
  async setup(): Promise<void> {}
  async upsertBatch(writes: WriteRequest[]): Promise<WriteResult> {
    return {
      pathsTouched: writes.map((w) => `${w.table}:${w.key}`).sort(),
      recordCount: writes.length,
    };
  }
  async deletePaths(paths: string[]): Promise<DeleteResult> {
    return { deleted: paths, missing: [] };
  }
  async recordExists(): Promise<boolean> {
    return true;
  }
  async findUniqueConflicts(): Promise<string[]> {
    return [];
  }
  name(): string {
    return "memory";
  }
  async scopeTarget(): Promise<string | undefined> {
    return undefined;
  }
}

function makeSeed(name: string, batch: string, prompt: string): Seed {
  return {
    name,
    scope: ["development"],
    dependsOn: [],
    requires: [],
    requiresSchemas: { person: "1" },
    generators: {
      [batch]: {
        generator: "stub",
        schema: "person",
        prompt,
        maxRecords: 10,
      },
    },
    keyHash: hashCanonical(`${name}:${prompt}`),
  };
}

describe("SeedRunner.regenerate", () => {
  it("writes a canonical cache file and returns the outcome", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "seed-regen-"));
    try {
      const cfg = new SeedConfig({
        backends: new ScopedBackends(),
        scopeTarget: "development",
        cacheDir,
      });
      cfg.schemas.register(personSchema.name, personSchema);
      cfg.generators.register(
        "stub",
        new StubGenerator([{ name: "Ada" }, { name: "Linus" }], {
          prompt: 100,
          completion: 50,
        }, 0.001),
      );
      const seed = makeSeed("demo", "batch1", "make 2 people");
      cfg.seeds.register(seed.name, seed);

      const runner = new SeedRunner(cfg);
      const out = await runner.regenerate(["demo"]);

      expect(out.seedsProcessed).toBe(1);
      expect(out.recordCount).toBe(2);
      expect(out.droppedCount).toBe(0);
      expect(out.dryRun).toBe(false);

      const cache = loadCacheFile(cacheDir, "demo", "batch1");
      expect(cache.generator.name).toBe("stub");
      expect(cache.generator.schema_version).toBe("1");
      expect(cache.generator.prompt_hash).toBe(promptHash("make 2 people"));
      expect(cache.generator.record_count).toBe(2);
      expect(cache.data).toEqual([{ name: "Ada" }, { name: "Linus" }]);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("dryRun emits invoked but skips the write", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "seed-regen-"));
    try {
      const cfg = new SeedConfig({
        backends: new ScopedBackends(),
        scopeTarget: "development",
        cacheDir,
      });
      cfg.schemas.register(personSchema.name, personSchema);
      cfg.generators.register("stub", new StubGenerator([{ name: "x" }]));
      const seed = makeSeed("demo", "batch1", "dry");
      cfg.seeds.register(seed.name, seed);

      const runner = new SeedRunner(cfg);
      const out = await runner.regenerate(["demo"], true);
      expect(out.dryRun).toBe(true);
      expect(() => loadCacheFile(cacheDir, "demo", "batch1")).toThrow(
        /E_GENERATOR_FAILED/,
      );
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("aborts when the per-seed cost cap is exceeded", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "seed-regen-"));
    try {
      const cfg = new SeedConfig({
        backends: new ScopedBackends(),
        scopeTarget: "development",
        cacheDir,
        costCaps: { perSeedUsd: 0.0001 },
      });
      cfg.schemas.register(personSchema.name, personSchema);
      cfg.generators.register(
        "stub",
        new StubGenerator([{ name: "x" }], undefined, 0.5),
      );
      const seed = makeSeed("demo", "batch1", "expensive");
      cfg.seeds.register(seed.name, seed);

      const runner = new SeedRunner(cfg);
      await expect(runner.regenerate(["demo"])).rejects.toThrow(
        /E_GENERATOR_BUDGET_EXCEEDED/,
      );
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("aborts when the generator times out", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "seed-regen-"));
    try {
      const cfg = new SeedConfig({
        backends: new ScopedBackends(),
        scopeTarget: "development",
        cacheDir,
        generatorTimeoutMs: 25,
      });
      cfg.schemas.register(personSchema.name, personSchema);
      cfg.generators.register("hang", new HangingGenerator());
      const seed: Seed = {
        ...makeSeed("demo", "batch1", "hang"),
        generators: {
          batch1: {
            generator: "hang",
            schema: "person",
            prompt: "hang",
            maxRecords: 1,
            timeoutMs: 25,
          },
        },
      };
      cfg.seeds.register(seed.name, seed);

      const runner = new SeedRunner(cfg);
      await expect(runner.regenerate(["demo"])).rejects.toThrow(
        /E_GENERATOR_TIMEOUT/,
      );
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("drops invalid records and aborts above the validation threshold", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "seed-regen-"));
    try {
      const cfg = new SeedConfig({
        backends: new ScopedBackends(),
        scopeTarget: "development",
        cacheDir,
      });
      cfg.schemas.register(personSchema.name, personSchema);
      // 2 of 3 fail validation → drop ratio 0.66 > default 0.20.
      cfg.generators.register(
        "stub",
        new StubGenerator([
          { name: "ok" },
          { wrong: "field" },
          { also: "bad" },
        ]),
      );
      const seed = makeSeed("demo", "batch1", "p");
      cfg.seeds.register(seed.name, seed);

      const runner = new SeedRunner(cfg);
      await expect(runner.regenerate(["demo"])).rejects.toThrow(
        /E_GENERATOR_FAILED/,
      );
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

describe("apply-side checkGeneratorCaches", () => {
  function buildRunner(cacheDir: string) {
    const cfg = new SeedConfig({
      backend: new MemoryBackend(),
      scopeTarget: "development",
      cacheDir,
    });
    cfg.schemas.register(personSchema.name, personSchema);
    cfg.generators.register("stub", new StubGenerator([{ name: "Ada" }]));
    return cfg;
  }

  it("rejects apply when the cache file is missing", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "seed-apply-"));
    try {
      const cfg = buildRunner(cacheDir);
      const seed = makeSeed("demo", "batch1", "p");
      cfg.seeds.register(seed.name, seed);
      const runner = new SeedRunner(cfg);
      await expect(runner.apply(["demo"])).rejects.toThrow(
        /E_GENERATOR_FAILED/,
      );
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("rejects apply when the cache prompt_hash drifted", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "seed-apply-"));
    try {
      // Run #1: regenerate against the original prompt.
      const cfg1 = buildRunner(cacheDir);
      cfg1.seeds.register("demo", makeSeed("demo", "batch1", "first prompt"));
      await new SeedRunner(cfg1).regenerate(["demo"]);

      // Run #2: fresh config (Registry refuses re-register) with a
      // *different* prompt for the same seed, pointing at the same
      // cache. The recorded prompt_hash now mismatches.
      const cfg2 = buildRunner(cacheDir);
      cfg2.seeds.register("demo", makeSeed("demo", "batch1", "edited prompt"));
      await expect(new SeedRunner(cfg2).apply(["demo"])).rejects.toThrow(
        /E_GENERATOR_FAILED/,
      );
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("rejects apply when the schema version was bumped", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "seed-apply-"));
    try {
      // Run #1: regenerate at schema v1 — cache records schema_version "1".
      const cfg1 = buildRunner(cacheDir);
      cfg1.seeds.register("demo", makeSeed("demo", "batch1", "p"));
      await new SeedRunner(cfg1).regenerate(["demo"]);

      // Run #2: schema bumped to v2 *and* seed updated to require v2.
      // The apply-time `requiresSchemas` check passes (declared v2 ==
      // registered v2) but the cache file's recorded schema_version
      // is still "1", so the cache-stale check trips.
      const cfg2 = new SeedConfig({
        backend: new MemoryBackend(),
        scopeTarget: "development",
        cacheDir,
      });
      cfg2.schemas.register("person", { ...personSchema, version: "2" });
      cfg2.generators.register("stub", new StubGenerator([{ name: "Ada" }]));
      cfg2.seeds.register("demo", {
        ...makeSeed("demo", "batch1", "p"),
        requiresSchemas: { person: "2" },
      });
      await expect(new SeedRunner(cfg2).apply(["demo"])).rejects.toThrow(
        /E_GENERATOR_FAILED/,
      );
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("passes apply when the cache is fresh and matches", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "seed-apply-"));
    try {
      const cfg = buildRunner(cacheDir);
      const seed = makeSeed("demo", "batch1", "p");
      cfg.seeds.register(seed.name, seed);
      const runner = new SeedRunner(cfg);
      await runner.regenerate(["demo"]);

      // No SeedAction registered → apply is a no-op besides the
      // cache check, which should succeed.
      await runner.apply(["demo"]);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
