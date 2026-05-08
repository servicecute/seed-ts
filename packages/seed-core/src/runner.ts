import * as fs from "node:fs";
import * as path from "node:path";
import {
  ScopedBackends,
  type DbBackend,
  type WriteRequest,
} from "./backend.js";
import { SeedError } from "./error.js";
import {
  type IdentityBinding,
  type IdentityProvider,
  type IdentityProviderRegistry,
  type TrackedIdentity,
  IdentityError,
  getJsonPointer,
  setJsonPointer,
} from "./identity.js";
import {
  type EventEmitter,
  type EventLevel,
  StdoutNdjsonEmitter,
  makeEvent,
} from "./event.js";
import {
  type CacheFile,
  type CacheProvenance,
  type GeneratorContext,
  type GeneratorRegistry,
  loadCacheFile,
  PricingRegistry,
  promptHash,
  writeCanonicalCache,
} from "./generator.js";
import {
  type LockClaim,
  type LockHolder,
  type LockVerb,
} from "./lock.js";
import { Registry } from "./registry.js";
import {
  compile,
  registryToJson as registryToJsonImported,
  validateRecord,
  type SchemaEntry,
  type SchemaRegistry,
} from "./schema.js";
import {
  applyKeyExpr,
  asRefMarker,
  keyTemplateLookupKey,
  topologicalOrder,
  type OwnedWrite,
  type RefTarget,
  type Seed,
  type SeedActionRegistry,
  type SeedRegistry,
} from "./seed.js";
import type { KeyExpr } from "./key-expr.js";
import type { TrackingEntry } from "./tracking.js";
import {
  resolveMarkers,
  type TransformerRegistry,
} from "./transformer.js";

export interface CostCaps {
  perSeedUsd?: number;
  perRunUsd?: number;
}

/** Summary returned by {@link SeedRunner.regenerate} (spec §17.6). */
export interface RegenerateOutcome {
  seedsProcessed: number;
  recordCount: number;
  droppedCount: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  dryRun: boolean;
}

/** Spec §9.3 single-backend convenience options. */
export interface SeedConfigOpts<B extends DbBackend> {
  /** Single already-constructed backend. Mutually exclusive with `backends`. */
  backend?: B;
  /** Multi-scope router (spec §9.3). Mutually exclusive with `backend`. */
  backends?: ScopedBackends<B>;
  scopeTarget?: string;
  lockTtlMs?: number;
  generatorTimeoutMs?: number;
  validationThreshold?: number;
  /**
   * Root directory for generator cache files (spec §17.2/§17.3).
   * `seed regenerate` writes
   * `<cacheDir>/<seed-name>/data/<batch-name>.cached.json`. Apply-side
   * loading of generator-backed batches reads from here. Defaults to
   * `./.seed-cache`.
   */
  cacheDir?: string;
  costCaps?: CostCaps;
  emitter?: EventEmitter;
  specVersion?: string;
  holderLabel?: string;
}

export class SeedConfig<B extends DbBackend> {
  /** Backwards-compat single backend (spec §9.3). */
  private readonly eager: B | undefined;
  /** Spec §9.3 multi-scope registry. May be empty when using eager. */
  readonly backends: ScopedBackends<B>;
  readonly seeds: SeedRegistry = new Registry<Seed>();
  readonly actions: SeedActionRegistry = new Registry();
  readonly schemas: SchemaRegistry = new Registry<SchemaEntry>();
  readonly transformers: TransformerRegistry = new Registry();
  readonly generators: GeneratorRegistry = new Registry();
  /** Identity providers (proposed §25). Empty by default — non-auth
   * seeds never touch this registry. */
  readonly identityProviders: IdentityProviderRegistry = new Registry();
  readonly pricing: PricingRegistry = new PricingRegistry();
  scopeTarget: string;
  lockTtlMs: number;
  generatorTimeoutMs: number;
  validationThreshold: number;
  cacheDir: string;
  costCaps: CostCaps;
  emitter: EventEmitter;
  specVersion: string;
  holderLabel: string;

  constructor(opts: SeedConfigOpts<B>) {
    if (opts.backend && opts.backends) {
      throw new SeedError(
        "SeedConfig: pass either `backend` (single) or `backends` (router), not both",
      );
    }
    if (!opts.backend && !opts.backends) {
      throw new SeedError(
        "SeedConfig: must pass either `backend` (single) or `backends` (router)",
      );
    }
    this.eager = opts.backend;
    this.backends = opts.backends ?? new ScopedBackends<B>();
    this.scopeTarget = opts.scopeTarget ?? "";
    this.lockTtlMs = opts.lockTtlMs ?? 5 * 60 * 1000;
    this.generatorTimeoutMs = opts.generatorTimeoutMs ?? 60 * 1000;
    this.validationThreshold = opts.validationThreshold ?? 0.2;
    this.cacheDir = opts.cacheDir ?? ".seed-cache";
    this.costCaps = opts.costCaps ?? {};
    this.emitter = opts.emitter ?? new StdoutNdjsonEmitter();
    this.specVersion = opts.specVersion ?? "0.4.3";
    this.holderLabel = opts.holderLabel ?? "";
  }

  /**
   * Resolve `scope` (per-call override or ambient `scopeTarget`) to
   * a backend per spec §9.3:
   *
   * 1. If the registry has factories, the scope MUST match one of
   *    them. Unregistered → `E_SCOPE_VIOLATION` listing available
   *    scopes.
   * 2. Otherwise the eager (single-backend) fallback applies, but
   *    only when the requested scope matches the configured
   *    `scopeTarget` (or `scopeTarget` is empty — the test bypass).
   * 3. Otherwise `E_INTERNAL` (no backend configured at all).
   */
  async resolveBackend(scope: string): Promise<B> {
    if (this.backends.names().length > 0) {
      return this.backends.resolve(scope);
    }
    if (this.eager) {
      if (this.scopeTarget === "" || scope === this.scopeTarget) {
        return this.eager;
      }
      throw SeedError.coded(
        "E_SCOPE_VIOLATION",
        `scope ${JSON.stringify(scope)} requested but the single-backend SeedConfig is registered only under ${JSON.stringify(this.scopeTarget)}; pass \`backends\` for multi-scope routing`,
      );
    }
    throw SeedError.coded(
      "E_INTERNAL",
      "SeedConfig has neither an eager backend nor registered factories",
    );
  }
}

/** Runner status enumeration (spec §5, §10.6). */
export type SeedState =
  | { kind: "pending" }
  | { kind: "applied"; keyHash: string; appliedAt: string }
  | { kind: "drifted"; trackedHash: string; currentHash: string }
  | { kind: "orphaned"; appliedAt: string; pathsTouched: string[] };

export interface SeedStatus {
  name: string;
  state: SeedState;
}

export interface SeedSummary {
  name: string;
  scope: string[];
  dependsOn: string[];
  requires: string[];
  requiresSchemas: Record<string, string>;
}

/** Spec §9.1: scope gate. */
export function checkScope(seed: Seed, scopeTarget: string): void {
  if (!scopeTarget) return;
  if (seed.scope.includes(scopeTarget)) return;
  throw SeedError.coded(
    "E_SCOPE_VIOLATION",
    `seed ${JSON.stringify(seed.name)} declared scope ${JSON.stringify(seed.scope)}; current target ${JSON.stringify(scopeTarget)}`,
  );
}

/** Spec §7.3 / §9.1: production scope is forbidden in seeds. */
export function rejectProductionScope(seed: Seed): void {
  if (seed.scope.includes("production")) {
    throw SeedError.coded(
      "E_SCOPE_VIOLATION",
      `seed ${JSON.stringify(seed.name)} declares production in scope; production data belongs to a data migration (§7.3)`,
    );
  }
}

/** Spec §5: drift detection (returns void on match, throws on mismatch). */
export function checkDrift(
  seed: Seed,
  tracked: TrackingEntry,
  force: boolean,
): void {
  if (force || seed.keyHash === tracked.keyHash) return;
  throw SeedError.coded(
    "E_DRIFT_REFUSED",
    `seed ${JSON.stringify(seed.name)} drifted: tracked=${JSON.stringify(tracked.keyHash)}, current=${JSON.stringify(seed.keyHash)}; re-apply with --force`,
  );
}

/**
 * Spec §4.1 + §14.5 + §16.5: every seed's `requires`,
 * `requiresSchemas`, and `dependsOn` references must resolve before
 * the runner performs any writes. Returns the first violation it
 * finds with the appropriate spec error code.
 */
export function validateReferences<B extends DbBackend>(
  config: SeedConfig<B>,
): void {
  for (const name of config.seeds.names()) {
    const seed = config.seeds.lookup(name)!;
    for (const t of seed.requires) {
      if (!config.transformers.lookup(t)) {
        throw SeedError.coded(
          "E_TRANSFORMER_MISSING",
          `seed ${JSON.stringify(seed.name)} requires transformer ${JSON.stringify(t)} but none is registered`,
        );
      }
    }
    for (const [schemaName, expected] of Object.entries(seed.requiresSchemas)) {
      const entry = config.schemas.lookup(schemaName);
      if (!entry) {
        throw SeedError.coded(
          "E_SCHEMA_NOT_FOUND",
          `seed ${JSON.stringify(seed.name)} requires schema ${JSON.stringify(schemaName)} but none is registered`,
        );
      }
      if (entry.version !== expected) {
        throw SeedError.coded(
          "E_SCHEMA_VERSION_MISMATCH",
          `seed ${JSON.stringify(seed.name)} requires schema ${JSON.stringify(schemaName)} v${JSON.stringify(expected)}; registry holds v${JSON.stringify(entry.version)}`,
        );
      }
    }
    for (const parent of seed.dependsOn) {
      if (!config.seeds.lookup(parent)) {
        throw SeedError.coded(
          "E_INTERNAL",
          `seed ${JSON.stringify(seed.name)} depends on undeclared seed ${JSON.stringify(parent)}`,
        );
      }
    }
  }
}

/**
 * RAII-style guard for the apply-class advisory lock plus its
 * heartbeat task (spec §10.5). Caller MUST `await guard.release()`
 * along the success and error paths.
 */
class LockGuard {
  private interval: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly backend: DbBackend,
    private claim: LockClaim | undefined,
    intervalMs: number,
  ) {
    if (claim && intervalMs > 0) {
      const c = claim;
      this.interval = setInterval(() => {
        backend.lock().heartbeat(c).catch((e) => {
          process.stderr.write(`seed: heartbeat failed: ${(e as Error).message}\n`);
        });
      }, intervalMs);
      // Don't keep the process alive on the heartbeat alone.
      this.interval.unref?.();
    }
  }

  async release(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    if (this.claim) {
      try {
        await this.backend.lock().release(this.claim);
      } catch (_e) {
        // Best-effort — TTL ensures eventual reclaim.
      }
      this.claim = undefined;
    }
  }
}

function buildHolder(label: string): LockHolder {
  return {
    host: process.env["HOSTNAME"] ?? process.env["COMPUTERNAME"] ?? "unknown",
    pid: process.pid,
    label,
  };
}

/**
 * Race a promise against a hard timeout. If `body` doesn't settle
 * before `timeoutMs`, reject with the error returned by `onTimeout`.
 * The body promise is left to resolve in the background — we don't
 * have AbortController plumbed through every generator, but the
 * caller is responsible for not relying on its result.
 */
async function runWithTimeout<T>(
  body: () => Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
  });
  try {
    return await Promise.race([body(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Public seed runner. Drives every spec verb. */
export class SeedRunner<B extends DbBackend> {
  readonly config: SeedConfig<B>;

  constructor(config: SeedConfig<B>) {
    this.config = config;
  }

  /**
   * Apply named seeds in topological order (§13.6). Empty `names`
   * applies every registered seed. Uses ambient `scopeTarget`. For
   * per-call scope override (§9.5) see `applyWithScope`.
   */
  apply(names: string[]): Promise<void> {
    return this.dispatch("apply", names, false, undefined);
  }

  /** Apply with explicit scope override (spec §9.5). */
  applyWithScope(names: string[], scope: string): Promise<void> {
    return this.dispatch("apply", names, false, scope);
  }

  /** Same as `apply` but with `--force` semantics (§11.1). */
  applyForce(names: string[]): Promise<void> {
    return this.dispatch("apply", names, true, undefined);
  }

  /** `applyForce` with explicit scope override (spec §9.5). */
  applyForceWithScope(names: string[], scope: string): Promise<void> {
    return this.dispatch("apply", names, true, scope);
  }

  /**
   * Reset named seeds (spec §12 + §13.2). RESTRICT by default — refuses
   * if any applied seed depends on the target. `cascade=true` resets
   * dependents first in reverse topological order. `sudo` is required
   * per §11.2.
   */
  async reset(names: string[], cascade: boolean, sudo: boolean): Promise<void> {
    if (!sudo) {
      throw SeedError.coded(
        "E_RESET_RESTRICTED",
        "seed reset requires --sudo (§11.2)",
      );
    }
    await this.dispatchReset(names, cascade, false, undefined);
  }

  /** Reset with explicit scope override (spec §9.5). */
  async resetWithScope(
    names: string[],
    cascade: boolean,
    sudo: boolean,
    scope: string,
  ): Promise<void> {
    if (!sudo) {
      throw SeedError.coded(
        "E_RESET_RESTRICTED",
        "seed reset requires --sudo (§11.2)",
      );
    }
    await this.dispatchReset(names, cascade, false, scope);
  }

  /** Reset every applied seed; `--cascade` is implied (§13.2). */
  async resetAll(sudo: boolean): Promise<void> {
    if (!sudo) {
      throw SeedError.coded(
        "E_RESET_RESTRICTED",
        "seed reset --all requires --sudo (§11.2)",
      );
    }
    await this.dispatchReset([], true, true, undefined);
  }

  /** `resetAll` with explicit scope override (spec §9.5). */
  async resetAllWithScope(sudo: boolean, scope: string): Promise<void> {
    if (!sudo) {
      throw SeedError.coded(
        "E_RESET_RESTRICTED",
        "seed reset --all requires --sudo (§11.2)",
      );
    }
    await this.dispatchReset([], true, true, scope);
  }

  /** Spec §11.1: applied / pending / drifted / orphaned snapshot. */
  async status(): Promise<SeedStatus[]> {
    return this.statusInner(undefined);
  }

  /** `status` with explicit scope override (spec §9.5). */
  async statusWithScope(scope: string): Promise<SeedStatus[]> {
    return this.statusInner(scope);
  }

  private async statusInner(
    scopeOverride: string | undefined,
  ): Promise<SeedStatus[]> {
    const scope = this.effectiveScope(scopeOverride);
    const backend = await this.setupResolved(scope);
    const tracked = await backend.tracking().list();
    const byName = new Map(tracked.map((t) => [t.name, t]));
    const out: SeedStatus[] = [];
    for (const name of this.config.seeds.names()) {
      const seed = this.config.seeds.lookup(name)!;
      const t = byName.get(name);
      let state: SeedState;
      if (!t) {
        state = { kind: "pending" };
      } else if (t.keyHash === seed.keyHash) {
        state = { kind: "applied", keyHash: t.keyHash, appliedAt: t.appliedAt };
      } else {
        state = {
          kind: "drifted",
          trackedHash: t.keyHash,
          currentHash: seed.keyHash,
        };
      }
      out.push({ name, state });
    }
    // Orphans — tracking entries with no matching seed in the registry.
    for (const t of tracked) {
      if (!this.config.seeds.lookup(t.name)) {
        out.push({
          name: t.name,
          state: {
            kind: "orphaned",
            appliedAt: t.appliedAt,
            pathsTouched: t.pathsTouched,
          },
        });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** Spec §11.1: enumerate every defined seed regardless of state. */
  list(): SeedSummary[] {
    const out: SeedSummary[] = this.config.seeds.names().map((name) => {
      const seed = this.config.seeds.lookup(name)!;
      return {
        name: seed.name,
        scope: seed.scope,
        dependsOn: seed.dependsOn,
        requires: seed.requires,
        requiresSchemas: { ...seed.requiresSchemas },
      };
    });
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /**
   * Spec §11.1: dry-run validation pass. Same parse-time checks as
   * apply, plus invokes each seed's `SeedAction.produce` (if
   * registered) so consumers see fixture-builder errors without
   * touching the DB.
   */
  async validate(names: string[]): Promise<void> {
    return this.validateInner(names, undefined);
  }

  /** `validate` with explicit scope override (spec §9.5). */
  async validateWithScope(names: string[], scope: string): Promise<void> {
    return this.validateInner(names, scope);
  }

  private async validateInner(
    names: string[],
    scopeOverride: string | undefined,
  ): Promise<void> {
    const started = Date.now();
    const scope = this.effectiveScope(scopeOverride);
    // Validate is writeless — resolve the backend for naming +
    // §9.4 cross-check, but do NOT call backend.setup() so we keep
    // the spec §11.1 dry-run promise.
    const backend = await this.config.resolveBackend(scope);
    const reported = await backend.scopeTarget();
    if (reported !== undefined && scope !== "" && scope !== reported) {
      throw SeedError.coded(
        "E_SCOPE_VIOLATION",
        `validate: scope mismatch — requested ${JSON.stringify(scope)}, backend reports ${JSON.stringify(reported)}`,
      );
    }
    this.emit("info", "runner.starting", {
      verb: "validate",
      args: names,
      format: "json",
      backend: backend.name(),
      scope_target: scope,
    });

    try {
      for (const name of this.config.seeds.names()) {
        rejectProductionScope(this.config.seeds.lookup(name)!);
      }
      validateReferences(this.config);
      const topo = topologicalOrder(this.config.seeds);
      const targetSet = names.length === 0 ? new Set(topo) : new Set(names);
      for (const name of topo) {
        if (!targetSet.has(name)) continue;
        const seed = this.config.seeds.lookup(name)!;
        checkScope(seed, scope);
        let recordCount = 0;
        const action = this.config.actions.lookup(name);
        if (action) {
          const writes = await action.produce();
          recordCount = writes.length;
        }
        this.emit(
          "info",
          "seed.validate.ok",
          { record_count: recordCount, ref_count: 0 },
          name,
        );
      }
    } catch (e) {
      const err = e instanceof SeedError ? e : undefined;
      this.emit("error", "runner.failed", {
        verb: "validate",
        error_code: err?.code ?? "E_INTERNAL",
        message: (e as Error).message,
      });
      throw e;
    }

    this.emit("info", "runner.completed", {
      verb: "validate",
      duration_ms: Date.now() - started,
      applied_count: 0,
      skipped_count: 0,
      error_count: 0,
    });
  }

  /**
   * Remove orphaned tracking entries (spec §10.6). `cascade` also
   * deletes the underlying records; `dryRun` only reports.
   */
  async prune(
    sudo: boolean,
    cascade: boolean,
    dryRun: boolean,
  ): Promise<string[]> {
    return this.pruneInner(sudo, cascade, dryRun, undefined);
  }

  /** `prune` with explicit scope override (spec §9.5). */
  async pruneWithScope(
    sudo: boolean,
    cascade: boolean,
    dryRun: boolean,
    scope: string,
  ): Promise<string[]> {
    return this.pruneInner(sudo, cascade, dryRun, scope);
  }

  private async pruneInner(
    sudo: boolean,
    cascade: boolean,
    dryRun: boolean,
    scopeOverride: string | undefined,
  ): Promise<string[]> {
    if (!sudo && !dryRun) {
      throw SeedError.coded(
        "E_RESET_RESTRICTED",
        "seed prune requires --sudo (§11.2)",
      );
    }
    const scope = this.effectiveScope(scopeOverride);
    const backend = await this.setupResolved(scope);
    const tracked = await backend.tracking().list();
    const orphans = tracked.filter((t) => !this.config.seeds.lookup(t.name));
    const names = orphans.map((t) => t.name);
    if (dryRun) return names;

    const holder = buildHolder(this.config.holderLabel);
    const claim = await backend.lock().acquire("apply", holder, this.config.lockTtlMs);
    const guard = new LockGuard(
      backend,
      claim,
      Math.max(1000, Math.floor(this.config.lockTtlMs / 3)),
    );
    try {
      for (const orphan of orphans) {
        if (cascade) {
          await backend.deletePaths(orphan.pathsTouched);
        }
        await backend.tracking().remove(orphan.name);
      }
    } finally {
      await guard.release();
    }
    return names;
  }

  async forceUnlock(verb: LockVerb): Promise<void> {
    return this.forceUnlockInner(verb, undefined);
  }

  /** `forceUnlock` with explicit scope override (spec §9.5). */
  async forceUnlockWithScope(verb: LockVerb, scope: string): Promise<void> {
    return this.forceUnlockInner(verb, scope);
  }

  private async forceUnlockInner(
    verb: LockVerb,
    scopeOverride: string | undefined,
  ): Promise<void> {
    const scope = this.effectiveScope(scopeOverride);
    const backend = await this.setupResolved(scope);
    await backend.lock().forceUnlock(verb);
  }

  /**
   * Regenerate cache files for seeds with declared generators
   * (spec §17.6). Walks each seed's `generators` map, enforces the
   * per-seed and per-run cost caps, invokes the generator under a
   * hard timeout, validates records against the registered schema,
   * drops failures (aborting if drop ratio > threshold), and writes
   * the canonical cache file at
   * `<cacheDir>/<seed-name>/data/<batch-name>.cached.json`.
   *
   * Empty `names` ⇒ regenerate every seed with at least one
   * generator declared. `dryRun=true` skips invocation/write —
   * emits `seed.generator.invoked` with the estimated cost so the
   * operator sees the plan without paying.
   */
  async regenerate(
    names: string[],
    dryRun: boolean = false,
  ): Promise<RegenerateOutcome> {
    const started = Date.now();
    this.emit("info", "runner.starting", {
      verb: "regenerate",
      args: names,
      dry_run: dryRun,
    });

    const cacheDir = this.config.cacheDir;

    // Pick the target seed set.
    let targets: string[];
    if (names.length === 0) {
      targets = this.config.seeds.names().filter((n) => {
        const s = this.config.seeds.lookup(n);
        return s && s.generators && Object.keys(s.generators).length > 0;
      });
    } else {
      for (const n of names) {
        if (!this.config.seeds.lookup(n)) {
          throw SeedError.coded(
            "E_INTERNAL",
            `regenerate: seed ${JSON.stringify(n)} not registered`,
          );
        }
      }
      targets = names;
    }

    let totalActualCost = 0;
    let totalEstimatedCost = 0;
    let totalRecordCount = 0;
    let totalDroppedCount = 0;

    for (const name of targets) {
      const seed = this.config.seeds.lookup(name)!;
      const bindings = seed.generators ?? {};
      if (Object.keys(bindings).length === 0) {
        this.emit("info", "seed.generator.skipped", {
          seed: name,
          reason: "no generators declared",
        });
        continue;
      }

      for (const [batchName, binding] of Object.entries(bindings)) {
        const generator = this.config.generators.lookup(binding.generator);
        if (!generator) {
          throw SeedError.coded(
            "E_GENERATOR_NOT_FOUND",
            `seed ${JSON.stringify(name)} batch ${JSON.stringify(batchName)}: generator ${JSON.stringify(binding.generator)} not registered`,
          );
        }
        const schemaEntry = this.config.schemas.lookup(binding.schema);
        if (!schemaEntry) {
          throw SeedError.coded(
            "E_SCHEMA_NOT_FOUND",
            `seed ${JSON.stringify(name)} batch ${JSON.stringify(batchName)}: schema ${JSON.stringify(binding.schema)} not registered`,
          );
        }

        const timeoutMs = binding.timeoutMs ?? this.config.generatorTimeoutMs;
        const validationThreshold =
          binding.validationThreshold ?? this.config.validationThreshold;

        const ctx: GeneratorContext = {
          schemaName: binding.schema,
          schema: schemaEntry,
          prompt: binding.prompt,
          maxRecords: binding.maxRecords,
          maxTokens: binding.maxTokens,
          timeoutMs,
          validationThreshold,
          params: binding.params,
        };

        const estimated = generator.estimateCost(ctx);
        if (
          estimated !== undefined &&
          this.config.costCaps.perSeedUsd !== undefined &&
          estimated > this.config.costCaps.perSeedUsd
        ) {
          throw SeedError.coded(
            "E_GENERATOR_BUDGET_EXCEEDED",
            `seed ${JSON.stringify(name)} batch ${JSON.stringify(batchName)}: estimated $${estimated.toFixed(4)} exceeds per-seed cap $${this.config.costCaps.perSeedUsd.toFixed(4)}`,
          );
        }
        if (
          estimated !== undefined &&
          this.config.costCaps.perRunUsd !== undefined &&
          totalEstimatedCost + estimated > this.config.costCaps.perRunUsd
        ) {
          throw SeedError.coded(
            "E_GENERATOR_BUDGET_EXCEEDED",
            `regenerate: cumulative estimated $${(totalEstimatedCost + estimated).toFixed(4)} would exceed per-run cap $${this.config.costCaps.perRunUsd.toFixed(4)}`,
          );
        }
        if (estimated !== undefined) totalEstimatedCost += estimated;

        const paramsModel =
          binding.params && typeof binding.params === "object"
            ? (binding.params as Record<string, unknown>)["model"]
            : undefined;
        this.emit("info", "seed.generator.invoked", {
          seed: name,
          batch: batchName,
          generator: binding.generator,
          schema: binding.schema,
          model: paramsModel,
          estimated_cost_usd: estimated,
          dry_run: dryRun,
        });

        if (dryRun) continue;

        // Hard timeout on the generator call.
        const output = await runWithTimeout(
          () => generator.generate(ctx),
          timeoutMs,
          () => {
            const msg = `seed ${JSON.stringify(name)} batch ${JSON.stringify(batchName)}: generator ${JSON.stringify(binding.generator)} timed out after ${timeoutMs}ms`;
            this.emit("error", "seed.generator.failed", {
              seed: name,
              batch: batchName,
              error_code: "E_GENERATOR_TIMEOUT",
              message: msg,
            });
            return SeedError.coded("E_GENERATOR_TIMEOUT", msg);
          },
        ).catch((e: unknown) => {
          if (e instanceof SeedError) throw e;
          const coded = SeedError.coded(
            "E_GENERATOR_FAILED",
            `seed ${JSON.stringify(name)} batch ${JSON.stringify(batchName)}: ${(e as Error).message}`,
            e,
          );
          this.emit("error", "seed.generator.failed", {
            seed: name,
            batch: batchName,
            error_code: "E_GENERATOR_FAILED",
            message: coded.message,
          });
          throw coded;
        });

        // Schema-validate every record. Drop failures; abort if too
        // many were dropped (§17.4).
        const accepted: unknown[] = [];
        let dropped = output.droppedCount;
        for (let idx = 0; idx < output.records.length; idx++) {
          const rec = output.records[idx];
          try {
            validateRecord(schemaEntry, rec);
            accepted.push(rec);
          } catch (e) {
            dropped += 1;
            this.emit("warn", "seed.generator.record_dropped", {
              seed: name,
              batch: batchName,
              record_index: idx,
              reason: (e as Error).message,
            });
          }
        }

        const totalRecords = accepted.length + dropped;
        const dropRatio = totalRecords === 0 ? 0 : dropped / totalRecords;
        if (dropRatio > validationThreshold) {
          const msg = `seed ${JSON.stringify(name)} batch ${JSON.stringify(batchName)}: ${dropped}/${totalRecords} records failed validation (ratio ${dropRatio.toFixed(3)} > threshold ${validationThreshold.toFixed(3)})`;
          this.emit("error", "seed.generator.failed", {
            seed: name,
            batch: batchName,
            error_code: "E_GENERATOR_FAILED",
            message: msg,
          });
          throw SeedError.coded("E_GENERATOR_FAILED", msg);
        }

        const provenance: CacheProvenance = {
          name: binding.generator,
          schema: binding.schema,
          schema_version: schemaEntry.version,
          model: typeof paramsModel === "string" ? paramsModel : undefined,
          prompt_hash: promptHash(binding.prompt),
          generated_at: new Date().toISOString(),
          record_count: accepted.length,
          tokens: output.tokens,
        };
        const file: CacheFile = { generator: provenance, data: accepted };
        const bytes = writeCanonicalCache(file);

        const dir = path.join(cacheDir, name, "data");
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch (e) {
          throw SeedError.coded(
            "E_INTERNAL",
            `regenerate: create cache dir ${JSON.stringify(dir)}: ${(e as Error).message}`,
          );
        }
        const filePath = path.join(dir, `${batchName}.cached.json`);
        try {
          fs.writeFileSync(filePath, bytes);
        } catch (e) {
          throw SeedError.coded(
            "E_INTERNAL",
            `regenerate: write cache ${JSON.stringify(filePath)}: ${(e as Error).message}`,
          );
        }

        if (output.actualCostUsd !== undefined) {
          totalActualCost += output.actualCostUsd;
        }
        totalRecordCount += accepted.length;
        totalDroppedCount += dropped;

        this.emit("info", "seed.generator.completed", {
          seed: name,
          batch: batchName,
          generator: binding.generator,
          record_count: accepted.length,
          dropped_count: dropped,
          tokens: output.tokens,
          actual_cost_usd: output.actualCostUsd,
          cache_path: filePath,
        });
      }
    }

    this.emit("info", "runner.completed", {
      verb: "regenerate",
      duration_ms: Date.now() - started,
      seed_count: targets.length,
      record_count: totalRecordCount,
      dropped_count: totalDroppedCount,
      actual_cost_usd: totalActualCost,
      estimated_cost_usd: totalEstimatedCost,
      dry_run: dryRun,
    });

    return {
      seedsProcessed: targets.length,
      recordCount: totalRecordCount,
      droppedCount: totalDroppedCount,
      estimatedCostUsd: totalEstimatedCost,
      actualCostUsd: totalActualCost,
      dryRun,
    };
  }

  /**
   * Apply-side cache check (spec §17.5/§17.7). For every
   * generator-backed batch on `seed`, ensure:
   *   - the cache file exists and parses,
   *   - cached `$generator.schema_version` matches the schema's
   *     current version in the registry,
   *   - cached `$generator.prompt_hash` matches the canonical hash
   *     of the binding's current prompt.
   *
   * Mismatches emit `seed.generator.cache_stale` (warn) and abort
   * with `E_GENERATOR_FAILED`. Successful checks emit
   * `seed.generator.cache_hit` with `cache_age_days` so operators
   * can spot caches that drifted *behind* the prompt's intent.
   */
  private checkGeneratorCaches(seed: Seed): void {
    const bindings = seed.generators ?? {};
    if (Object.keys(bindings).length === 0) return;

    const cacheDir = this.config.cacheDir;
    for (const [batchName, binding] of Object.entries(bindings)) {
      let cache: CacheFile;
      try {
        cache = loadCacheFile(cacheDir, seed.name, batchName);
      } catch (e) {
        this.emit(
          "warn",
          "seed.generator.cache_stale",
          {
            batch: batchName,
            reason: "cache_missing",
            message: (e as Error).message,
          },
          seed.name,
        );
        throw e;
      }

      // §17.5: schema-version check.
      const currentSchema = this.config.schemas.lookup(binding.schema);
      if (!currentSchema) {
        throw SeedError.coded(
          "E_SCHEMA_NOT_FOUND",
          `seed ${JSON.stringify(seed.name)} batch ${JSON.stringify(batchName)}: schema ${JSON.stringify(binding.schema)} not registered`,
        );
      }
      if (cache.generator.schema_version !== currentSchema.version) {
        this.emit(
          "warn",
          "seed.generator.cache_stale",
          {
            batch: batchName,
            reason: "schema_bumped",
            cache_schema_version: cache.generator.schema_version,
            current_schema_version: currentSchema.version,
          },
          seed.name,
        );
        throw SeedError.coded(
          "E_GENERATOR_FAILED",
          `seed ${JSON.stringify(seed.name)} batch ${JSON.stringify(batchName)}: cache schema_version ${JSON.stringify(cache.generator.schema_version)} != current ${JSON.stringify(currentSchema.version)}; run \`seed regenerate ${seed.name}\``,
        );
      }

      // §17.7: prompt-hash check.
      const currentPromptHash = promptHash(binding.prompt);
      if (cache.generator.prompt_hash !== currentPromptHash) {
        this.emit(
          "warn",
          "seed.generator.cache_stale",
          {
            batch: batchName,
            reason: "prompt_changed",
            cache_prompt_hash: cache.generator.prompt_hash,
            current_prompt_hash: currentPromptHash,
          },
          seed.name,
        );
        throw SeedError.coded(
          "E_GENERATOR_FAILED",
          `seed ${JSON.stringify(seed.name)} batch ${JSON.stringify(batchName)}: cached prompt_hash != current; the seed's prompt was edited since the cache was generated. Run \`seed regenerate ${seed.name}\` and review the diff.`,
        );
      }

      // Both checks passed — emit cache_hit with age so operators
      // can spot caches that valid but drifting behind intent.
      const generatedAt = Date.parse(cache.generator.generated_at);
      const ageDays = Number.isFinite(generatedAt)
        ? Math.max(0, Math.floor((Date.now() - generatedAt) / 86_400_000))
        : null;
      this.emit(
        "info",
        "seed.generator.cache_hit",
        {
          batch: batchName,
          record_count: cache.generator.record_count,
          cache_age_days: ageDays,
          generator: cache.generator.name,
          model: cache.generator.model ?? null,
        },
        seed.name,
      );
    }
  }

  /** Spec §11.1 + §16.7: emit the schema registry as canonical JSON. */
  exportRegistry(): string {
    return registryToJsonImported(this.config.schemas);
  }

  // ────────────────── private reset orchestration ──────────────────

  private async dispatchReset(
    names: string[],
    cascade: boolean,
    all: boolean,
    scopeOverride: string | undefined,
  ): Promise<void> {
    const started = Date.now();
    const scope = this.effectiveScope(scopeOverride);

    let result: { removed: number; skipped: number };
    try {
      const backend = await this.setupResolved(scope);
      this.emit("info", "runner.starting", {
        verb: "reset",
        args: names,
        format: "json",
        backend: backend.name(),
        scope_target: scope,
        cascade,
        all,
      });
      result = await this.dispatchResetInner(backend, scope, names, cascade, all);
    } catch (e) {
      const err = e instanceof SeedError ? e : undefined;
      this.emit("error", "runner.failed", {
        verb: "reset",
        error_code: err?.code ?? "E_INTERNAL",
        message: (e as Error).message,
      });
      throw e;
    }

    this.emit("info", "runner.completed", {
      verb: "reset",
      duration_ms: Date.now() - started,
      applied_count: result.removed,
      skipped_count: result.skipped,
      error_count: 0,
    });
  }

  private async dispatchResetInner(
    backend: B,
    _scope: string,
    names: string[],
    cascade: boolean,
    all: boolean,
  ): Promise<{ removed: number; skipped: number }> {
    for (const name of this.config.seeds.names()) {
      rejectProductionScope(this.config.seeds.lookup(name)!);
    }

    const tracked = await backend.tracking().list();
    const appliedNames = new Set(tracked.map((t) => t.name));
    const trackedByName = new Map(tracked.map((t) => [t.name, t]));

    const targets = all
      ? Array.from(appliedNames)
      : names.length === 0
        ? (() => {
            throw SeedError.coded(
              "E_RESET_RESTRICTED",
              "seed reset requires either --all or one or more seed names",
            );
          })()
        : names;

    for (const name of targets) {
      if (!appliedNames.has(name)) {
        throw SeedError.coded(
          "E_RESET_RESTRICTED",
          `seed ${JSON.stringify(name)} is not applied`,
        );
      }
    }

    // §13.6: build reverse-topological order over the applied set.
    const topo = topologicalOrder(this.config.seeds);
    const appliedTopo = topo.filter((n) => appliedNames.has(n));
    const reverseTopo = [...appliedTopo].reverse();

    // §13.2 RESTRICT: refuse if any applied seed depends on the
    // target and we're not cascading.
    if (!cascade) {
      for (const target of targets) {
        const blockers: string[] = [];
        for (const name of appliedTopo) {
          if (name === target) continue;
          const seed = this.config.seeds.lookup(name);
          if (seed && seed.dependsOn.includes(target)) {
            blockers.push(name);
          }
        }
        if (blockers.length > 0) {
          this.emit(
            "error",
            "seed.reset.blocked",
            { dependent_seeds: blockers },
            target,
          );
          throw SeedError.coded(
            "E_RESET_RESTRICTED",
            `reset of ${JSON.stringify(target)} blocked by applied dependents: ${JSON.stringify(blockers)}; pass --cascade to override`,
          );
        }
      }
    }

    // Resolved set: cascade → transitive applied dependents + targets;
    // non-cascade → just the targets.
    const resolved = (() => {
      if (!cascade && !all) {
        return reverseTopo.filter((n) => targets.includes(n));
      }
      const targetSet = new Set(targets);
      const include = new Set<string>(targets);
      for (const name of appliedTopo) {
        if (include.has(name)) continue;
        const seed = this.config.seeds.lookup(name);
        if (!seed) continue;
        if (seed.dependsOn.some((d) => include.has(d) || targetSet.has(d))) {
          include.add(name);
        }
      }
      return reverseTopo.filter((n) => include.has(n));
    })();

    // §8.4: acquire apply-class lock — reset shares the slot.
    const holder = buildHolder(this.config.holderLabel);
    const claim = await backend.lock().acquire(
      "apply",
      holder,
      this.config.lockTtlMs,
    );
    const guard = new LockGuard(
      backend,
      claim,
      Math.max(1000, Math.floor(this.config.lockTtlMs / 3)),
    );

    try {
      let removed = 0;
      const skipped = 0;
      for (const name of resolved) {
        const entry = trackedByName.get(name);
        if (!entry) {
          throw SeedError.coded(
            "E_INTERNAL",
            `tracking entry vanished for ${JSON.stringify(name)}`,
          );
        }
        this.emit(
          "info",
          "seed.reset.starting",
          {
            paths_to_delete: entry.pathsTouched,
            cascade: cascade || all,
          },
          name,
        );
        const seedStarted = Date.now();
        const { deleted, missing } = await backend.deletePaths(
          entry.pathsTouched,
        );
        for (const path of missing) {
          this.emit("warn", "seed.reset.path_missing", { path_key: path }, name);
        }
        await backend.tracking().remove(name);

        // §25: tear down auth-side identities the seed minted. Data
        // is already gone — orphan identities are warned (operator
        // cleans up) but never abort the reset.
        if (entry.createdIdentities && entry.createdIdentities.length > 0) {
          const uids: Array<[string, string]> = entry.createdIdentities.map(
            (t) => [t.provider, t.uid],
          );
          await this.tearDownIdentities(name, uids, /*phase*/ "reset");
        }

        this.emit(
          "info",
          "seed.reset.applied",
          {
            record_count: deleted.length,
            duration_ms: Date.now() - seedStarted,
          },
          name,
        );
        removed += 1;
      }
      return { removed, skipped };
    } finally {
      await guard.release();
    }
  }

  // ────────────────── private apply orchestration ──────────────────

  private async dispatch(
    verb: string,
    names: string[],
    force: boolean,
    scopeOverride: string | undefined,
  ): Promise<void> {
    const started = Date.now();
    const scope = this.effectiveScope(scopeOverride);

    let result: { applied: number; skipped: number };
    try {
      const backend = await this.setupResolved(scope);
      this.emit("info", "runner.starting", {
        verb,
        args: names,
        format: "json",
        backend: backend.name(),
        scope_target: scope,
        force,
      });
      result = await this.dispatchInner(backend, scope, names, force);
    } catch (e) {
      const err = e instanceof SeedError ? e : undefined;
      const code = err?.code ?? "E_INTERNAL";
      this.emit("error", "runner.failed", {
        verb,
        error_code: code,
        message: (e as Error).message,
      });
      throw e;
    }

    this.emit("info", "runner.completed", {
      verb,
      duration_ms: Date.now() - started,
      applied_count: result.applied,
      skipped_count: result.skipped,
      error_count: 0,
    });
  }

  private async dispatchInner(
    backend: B,
    scope: string,
    names: string[],
    force: boolean,
  ): Promise<{ applied: number; skipped: number }> {
    // §7.3 / §9: production scope is forbidden at registration.
    // Re-validate every dispatch in case a buggy consumer slipped past.
    for (const name of this.config.seeds.names()) {
      rejectProductionScope(this.config.seeds.lookup(name)!);
    }

    // §4.1 + §14.5 + §16.5: refs must resolve before any write.
    validateReferences(this.config);

    // §13.6: topological apply order with alphabetical tie-break.
    const topo = topologicalOrder(this.config.seeds);
    const targetSet =
      names.length === 0 ? new Set(topo) : new Set(names);

    // §8.4: acquire the apply-class advisory lock + heartbeat.
    const holder = buildHolder(this.config.holderLabel);
    const claim = await backend.lock().acquire(
      "apply",
      holder,
      this.config.lockTtlMs,
    );
    const guard = new LockGuard(
      backend,
      claim,
      Math.max(1000, Math.floor(this.config.lockTtlMs / 3)),
    );

    try {
      return await this.applyLoop(backend, scope, topo, targetSet, force);
    } finally {
      await guard.release();
    }
  }

  private async applyLoop(
    backend: B,
    scope: string,
    topo: string[],
    targetSet: Set<string>,
    force: boolean,
  ): Promise<{ applied: number; skipped: number }> {
    let applied = 0;
    let skipped = 0;

    // Snapshot existing tracking once. Mutates as we apply seeds —
    // drift skips short-circuit, ownership transfer (§8.2) moves
    // paths between entries.
    const snapshot = await backend.tracking().list();
    const trackedByName: Map<string, TrackingEntry> = new Map(
      snapshot.map((t) => [t.name, t]),
    );

    for (const name of topo) {
      if (!targetSet.has(name)) continue;
      const seed = this.config.seeds.lookup(name)!;

      // §9: scope gate (against the scope active for this dispatch).
      try {
        checkScope(seed, scope);
      } catch (e) {
        this.emit(
          "error",
          "seed.scope_violation",
          {
            declared_scope: seed.scope,
            actual_scope: scope,
          },
          name,
        );
        throw e;
      }

      // §5: drift detection against existing tracking entry.
      const tracked = trackedByName.get(name);
      if (tracked) {
        if (!force && seed.keyHash === tracked.keyHash) {
          this.emit("info", "seed.skipped", { reason: "already_applied" }, name);
          skipped += 1;
          continue;
        }
        try {
          checkDrift(seed, tracked, force);
        } catch (e) {
          this.emit(
            "warn",
            "seed.drift_detected",
            { tracked_hash: tracked.keyHash, current_hash: seed.keyHash },
            name,
          );
          throw e;
        }
      }

      this.emit(
        "info",
        "seed.applying",
        { path_count: 0, dependsOn: seed.dependsOn },
        name,
      );
      const seedStarted = Date.now();

      // §17.5/§17.7: cache freshness check for generator-backed
      // batches. Bails before running the action if any cache is
      // stale or missing.
      this.checkGeneratorCaches(seed);

      // Run the seed's action (if registered) to produce writes.
      const action = this.config.actions.lookup(name);
      const rawProduced: OwnedWrite[] = action ? await action.produce() : [];

      // §25: identity binding resolution. Mints (or looks up) auth
      // identities BEFORE the data write and patches each record's
      // uid_targets. When `keyFromUid` is set, also replaces the
      // OwnedWrite.key with the minted uid. Anything we created
      // here is rolled back below if the data write or tracking
      // upsert fails.
      const identityResolution = await this.resolveIdentities(seed, rawProduced);
      const raw = identityResolution.records;
      const createdIdentities = identityResolution.tracked;
      const rollbackUids = identityResolution.rollback;

      // From here on, errors should trigger identity rollback.
      let bodyError: unknown = undefined;
      try {

      // §14.3: walk every record's `data` and replace transformer
      // markers. Sequential per-record; future T7.3 may parallelise.
      const owned: OwnedWrite[] = [];
      for (const record of raw) {
        const pathKey = `${record.table}:${record.key}`;
        const { value: resolvedData, applied: appliedMarkers } =
          await resolveMarkers(record.data, this.config.transformers, "");
        for (const m of appliedMarkers) {
          this.emit(
            "info",
            "seed.transformer.applied",
            // §14.6: input/output values MUST NOT be logged.
            { transformer: m.transformer, field: m.field, path_key: pathKey },
            name,
          );
        }
        owned.push({
          table: record.table,
          key: record.key,
          data: resolvedData,
        });
      }

      // §7.1: resolve every `$ref` marker. Skips the existence query
      // for refs to records produced earlier in the same run.
      const appliedPaths = new Set<string>();
      for (const entry of trackedByName.values()) {
        for (const p of entry.pathsTouched) appliedPaths.add(p);
      }
      for (const r of owned) {
        appliedPaths.add(`${r.table}:${r.key}`);
        appliedPaths.add(`${r.table}/${r.key}`);
      }
      for (const record of owned) {
        record.data = await this.resolveRefsIn(
          backend,
          name,
          record.data,
          backend.name(),
          appliedPaths,
        );
      }

      // §26: apply key templates registered via
      // `SeedAction.keyTemplates`. Runs after $ref + identity
      // resolution so templates can reference the post-binding
      // minted uids that landed in `record.data`. Lookup is by
      // (table, current_key) — the placeholder the seed emitted
      // from `produce()`.
      const action = this.config.actions.lookup(name);
      const templates =
        (action && typeof action.keyTemplates === "function"
          ? action.keyTemplates()
          : undefined) ?? new Map<string, KeyExpr>();
      if (templates.size > 0) {
        for (const record of owned) {
          const lookup = keyTemplateLookupKey(record.table, record.key);
          const template = templates.get(lookup);
          if (template !== undefined) {
            const finalKey = applyKeyExpr(template, record.data);
            this.emit(
              "info",
              "seed.key_template.applied",
              {
                table: record.table,
                placeholder_key: record.key,
              },
              name,
            );
            record.key = finalKey;
          }
        }
      }

      // §13.4 ext: pre-check declared FOREIGN_KEY constraints.
      // Catches typo'd uids in id-typed fields that weren't authored
      // as `$ref` markers. Records that reference a target written
      // earlier in this run pass via `applied_now`.
      const appliedNowFk = new Set<string>();
      for (const e of trackedByName.values()) {
        for (const p of e.pathsTouched) appliedNowFk.add(p);
      }
      for (const r of owned) {
        appliedNowFk.add(`${r.table}:${r.key}`);
        appliedNowFk.add(`${r.table}/${r.key}`);
      }
      for (const fk of seed.constraints?.foreignKey ?? []) {
        for (const record of owned) {
          if (record.table !== fk.path) continue;
          const value = walkDottedPath(record.data, fk.field);
          if (value === undefined || value === null) continue;
          if (typeof value !== "string" || value === "") continue;
          const surrealForm = `${fk.references}:${value}`;
          const firestoreForm = `${fk.references}/${value}`;
          if (appliedNowFk.has(surrealForm) || appliedNowFk.has(firestoreForm)) {
            continue;
          }
          const exists = await backend.recordExists(fk.references, value);
          if (!exists) {
            this.emit(
              "error",
              "seed.constraint_violation",
              {
                constraint_kind: "foreign_key",
                field: fk.field,
                references: fk.references,
                missing_target: value,
                path_key: `${record.table}/${record.key}`,
              },
              name,
            );
            throw SeedError.coded(
              "E_CONSTRAINT_FK",
              `seed ${JSON.stringify(name)}: declared FOREIGN_KEY on ${fk.path}.${fk.field} references ${JSON.stringify(fk.references)} but target ${JSON.stringify(value)} does not exist`,
            );
          }
        }
      }

      // §13.4: pre-check declared UNIQUE constraints.
      for (const unique of seed.constraints?.unique ?? []) {
        for (const record of owned) {
          if (record.table !== unique.path) continue;
          const value = walkDottedPath(record.data, unique.field);
          if (value === undefined) continue;
          const conflicts = await backend.findUniqueConflicts(
            unique.path,
            unique.field,
            value,
            record.key,
          );
          if (conflicts.length > 0) {
            this.emit(
              "error",
              "seed.constraint_violation",
              {
                constraint_kind: "unique",
                field: unique.field,
                path_key: `${record.table}/${record.key}`,
                db_message: `conflicting keys: ${JSON.stringify(conflicts)}`,
              },
              name,
            );
            throw SeedError.coded(
              "E_CONSTRAINT_UNIQUE",
              `seed ${JSON.stringify(name)}: declared UNIQUE on ${unique.path}.${unique.field} conflicts at key ${JSON.stringify(record.key)}`,
            );
          }
        }
      }

      // §16.5: validate each record against the registry's schema for
      // the target table. Pre-compile per unique table.
      const compiledSchemas = new Map<string, ReturnType<typeof compile>>();
      for (const record of owned) {
        const entry = this.config.schemas.lookup(record.table);
        if (!entry) continue;
        let validator = compiledSchemas.get(record.table);
        if (!validator) {
          validator = compile(entry);
          compiledSchemas.set(record.table, validator);
        }
        if (!validator(record.data)) {
          const err = validator.errors?.[0];
          throw SeedError.coded(
            "E_CONSTRAINT_TYPE",
            `seed ${JSON.stringify(name)}: record ${record.table}/${record.key} violates schema ${JSON.stringify(entry.name)} at ${err?.instancePath ?? ""}: ${err?.message ?? "validation failed"}`,
          );
        }
      }

      const writes: WriteRequest[] = owned.map((w) => ({
        table: w.table,
        key: w.key,
        data: w.data,
      }));
      const writeResult = await backend.upsertBatch(writes);

      // §10.1 / §17.3: paths_touched is canonically lex-sorted.
      const pathsTouched = Array.from(new Set(writeResult.pathsTouched)).sort();

      // §8.2: cross-seed ownership transfer. Move paths off any donor
      // tracking entry that currently claims them.
      const donors = this.findDonors(name, pathsTouched, trackedByName);
      for (const [donorName, donorEntry] of donors) {
        await backend.tracking().upsert(donorEntry);
        trackedByName.set(donorName, donorEntry);
      }
      for (const [donorName, donorPath] of this.transferPairs(
        name,
        pathsTouched,
        trackedByName,
      )) {
        this.emit(
          "warn",
          "seed.overwriting_owned",
          { owned_by: donorName, path_key: donorPath },
          name,
        );
      }

      // §10: write the tracking entry.
      const entry: TrackingEntry = {
        name,
        keyHash: seed.keyHash,
        scope: seed.scope,
        pathsTouched,
        appliedAt: new Date().toISOString(),
        specVersion: this.config.specVersion,
        trackingSchemaVersion: "1",
        ...(createdIdentities.length > 0 ? { createdIdentities } : {}),
      };
      await backend.tracking().upsert(entry);
      trackedByName.set(name, entry);

      this.emit(
        "info",
        "seed.applied",
        {
          record_count: writeResult.recordCount,
          paths_touched: pathsTouched,
          duration_ms: Date.now() - seedStarted,
        },
        name,
      );
      applied += 1;
      } catch (e) {
        bodyError = e;
      }
      if (bodyError !== undefined) {
        // Roll back any identities we minted for this seed. Reused
        // (looked-up) identities stay — they pre-existed the apply
        // attempt.
        if (rollbackUids.length > 0) {
          await this.tearDownIdentities(name, rollbackUids, /*phase*/ "rollback");
        }
        throw bodyError;
      }
    }

    return { applied, skipped };
  }

  /**
   * Spec §9.3 + §9.4: resolve the active scope to a backend, run
   * `setup()` to provision tracking + lock storage, and cross-check
   * the backend's self-reported scope against the requested one.
   * Mismatch surfaces as `E_SCOPE_VIOLATION` *before any tracking
   * write*. Backends that can't determine their scope return
   * `undefined`; the cross-check is skipped in that case.
   */
  private async setupResolved(requestedScope: string): Promise<B> {
    const backend = await this.config.resolveBackend(requestedScope);
    await backend.setup();
    const reported = await backend.scopeTarget();
    if (reported !== undefined && requestedScope !== "" && requestedScope !== reported) {
      throw SeedError.coded(
        "E_SCOPE_VIOLATION",
        `scope mismatch: requested ${JSON.stringify(requestedScope)}, but backend reports ${JSON.stringify(reported)} — likely a §9.3 registry misconfiguration`,
      );
    }
    return backend;
  }

  /**
   * Effective scope for this verb call: the per-call override per
   * §9.5, or the ambient `SeedConfig.scopeTarget` if no override.
   */
  private effectiveScope(perCall: string | undefined): string {
    if (perCall && perCall !== "") return perCall;
    return this.config.scopeTarget;
  }

  /**
   * Walk every {@link IdentityBinding} on the seed, resolve each
   * identity (lookup-or-create per `upsertStrategy`), patch each
   * data record's `uidTargets` JSON pointers + (optionally) replace
   * the OwnedWrite.key, and return the `(records, identities,
   * uids-to-roll-back)` triple.
   *
   * Empty-binding seeds short-circuit — the whole identity path
   * is a no-op when `Seed.identities` is empty.
   */
  private async resolveIdentities(
    seed: Seed,
    raw: OwnedWrite[],
  ): Promise<{
    records: OwnedWrite[];
    tracked: TrackedIdentity[];
    rollback: Array<[string, string]>; // (provider_name, uid)
  }> {
    const bindings = seed.identities ?? {};
    if (Object.keys(bindings).length === 0) {
      return { records: raw, tracked: [], rollback: [] };
    }

    const tracked: TrackedIdentity[] = [];
    const rollback: Array<[string, string]> = [];

    for (const [bindingName, binding] of Object.entries(bindings)) {
      const provider = this.config.identityProviders.lookup(binding.provider);
      if (!provider) {
        throw SeedError.coded(
          "E_IDENTITY_FAILED",
          `seed ${JSON.stringify(seed.name)} binding ${JSON.stringify(bindingName)}: identity provider ${JSON.stringify(binding.provider)} not registered`,
        );
      }

      let requests: typeof binding.source extends infer S
        ? S extends { kind: "inline"; requests: infer R }
          ? R
          : never
        : never;
      if (binding.source.kind === "inline") {
        requests = binding.source.requests as typeof requests;
      } else {
        throw SeedError.coded(
          "E_IDENTITY_FAILED",
          `seed ${JSON.stringify(seed.name)} binding ${JSON.stringify(bindingName)}: IdentitySource "fromBatch" is not yet supported`,
        );
      }

      const emailToUid = new Map<string, string>();

      for (const req of requests) {
        const email = req.email;
        let existing: { uid: string; email: string } | undefined;
        try {
          existing = await provider.lookupByEmail(email);
        } catch (e) {
          throw this.identityErrorToSeed(
            e,
            seed.name,
            bindingName,
            binding.provider,
            email,
          );
        }

        let record: { uid: string; email: string };
        if (existing) {
          if (binding.upsertStrategy === "failIfEmailExists") {
            this.emit(
              "error",
              "seed.identity.failed",
              {
                binding: bindingName,
                provider: binding.provider,
                email,
                error_code: "E_IDENTITY_FAILED",
                reason: "email_exists_under_fail_strategy",
              },
              seed.name,
            );
            throw SeedError.coded(
              "E_IDENTITY_FAILED",
              `seed ${JSON.stringify(seed.name)} binding ${JSON.stringify(bindingName)}: email ${JSON.stringify(email)} already has an identity (${JSON.stringify(existing.uid)}); strategy=failIfEmailExists`,
            );
          }
          this.emit(
            "info",
            "seed.identity.skipped",
            {
              binding: bindingName,
              provider: binding.provider,
              email,
              uid: existing.uid,
              reason: "email_exists",
            },
            seed.name,
          );
          record = existing;
        } else {
          try {
            record = await provider.createIdentity(req);
          } catch (e) {
            throw this.identityErrorToSeed(
              e,
              seed.name,
              bindingName,
              binding.provider,
              email,
            );
          }
          this.emit(
            "info",
            "seed.identity.created",
            {
              binding: bindingName,
              provider: binding.provider,
              email,
              uid: record.uid,
            },
            seed.name,
          );
          rollback.push([binding.provider, record.uid]);
        }

        tracked.push({
          provider: binding.provider,
          uid: record.uid,
          email: record.email,
          binding: bindingName,
        });
        emailToUid.set(email, record.uid);
      }

      // Patch every record whose match_field matches a resolved
      // email. Missing intermediate paths in `uidTargets` are silent
      // no-ops via `setJsonPointer`.
      for (const write of raw) {
        const matchValue = getJsonPointer(write.data, binding.matchField);
        if (typeof matchValue !== "string") continue;
        const uid = emailToUid.get(matchValue);
        if (uid === undefined) continue;
        for (const target of binding.uidTargets) {
          try {
            setJsonPointer(write.data, target, uid);
          } catch (e) {
            throw SeedError.coded(
              "E_IDENTITY_FAILED",
              `seed ${JSON.stringify(seed.name)} binding ${JSON.stringify(bindingName)}: cannot patch uidTarget ${JSON.stringify(target)}: ${(e as Error).message}`,
            );
          }
        }
        if (binding.keyFromUid) {
          write.key = uid;
        }
      }
    }

    return { records: raw, tracked, rollback };
  }

  /**
   * Walk a list of `(provider, uid)` pairs and call
   * {@link IdentityProvider.deleteIdentity} on each. Failures emit
   * `seed.identity.orphaned` (warn) and the loop continues —
   * orphan identities are recoverable; stopping mid-rollback would
   * be worse.
   */
  private async tearDownIdentities(
    seedName: string,
    uids: Array<[string, string]>,
    phase: "rollback" | "reset",
  ): Promise<void> {
    for (const [providerName, uid] of uids) {
      const provider = this.config.identityProviders.lookup(providerName);
      if (!provider) {
        this.emit(
          "warn",
          "seed.identity.orphaned",
          {
            provider: providerName,
            uid,
            reason: "provider_not_registered",
            phase,
          },
          seedName,
        );
        continue;
      }
      try {
        await provider.deleteIdentity(uid);
        this.emit(
          "info",
          "seed.identity.deleted",
          { provider: providerName, uid, phase },
          seedName,
        );
      } catch (e) {
        this.emit(
          "warn",
          "seed.identity.orphaned",
          {
            provider: providerName,
            uid,
            reason: `delete failed: ${(e as Error).message}`,
            phase,
          },
          seedName,
        );
      }
    }
  }

  private identityErrorToSeed(
    err: unknown,
    seedName: string,
    bindingName: string,
    providerName: string,
    email: string,
  ): SeedError {
    if (err instanceof IdentityError) {
      return err.toSeedError(seedName, bindingName, email);
    }
    return SeedError.coded(
      "E_IDENTITY_FAILED",
      `seed ${JSON.stringify(seedName)} binding ${JSON.stringify(bindingName)}: provider ${JSON.stringify(providerName)} on email ${JSON.stringify(email)}: ${(err as Error).message ?? String(err)}`,
      err,
    );
  }

  private async resolveRefsIn(
    backend: B,
    seedName: string,
    value: unknown,
    backendName: string,
    appliedPaths: Set<string>,
  ): Promise<unknown> {
    const refs: RefTarget[] = [];
    collectRefTargets(value, refs);
    if (refs.length === 0) return rewriteRefs(value, backendName, new Map());

    // §7.1.1 — resolve every Field-form ref to a concrete doc key
    // via backend.findKeyByField BEFORE the existence check.
    // E_REF_MISSING when no record matches.
    const fieldToKey = new Map<string, string>();
    for (const r of refs) {
      if (r.kind !== "field") continue;
      const cacheKey = `${r.table}|${r.field}|${r.value}`;
      if (fieldToKey.has(cacheKey)) continue;
      const resolved = await backend.findKeyByField(r.table, r.field, r.value);
      if (resolved === undefined) {
        throw SeedError.coded(
          "E_REF_MISSING",
          `seed ${JSON.stringify(seedName)} references ${r.table}/{ ${r.field}: ${JSON.stringify(r.value)} } but no record exists in ${r.table} with that ${r.field}`,
        );
      }
      fieldToKey.set(cacheKey, resolved);
    }

    // Collapse every RefTarget to a concrete (table, key) pair for
    // the existence check.
    const keys: Array<{ table: string; key: string }> = refs.map((r) => {
      if (r.kind === "key") return { table: r.table, key: r.key };
      const cacheKey = `${r.table}|${r.field}|${r.value}`;
      const resolved = fieldToKey.get(cacheKey);
      if (resolved === undefined) {
        throw new Error("ref resolved above but missing in cache");
      }
      return { table: r.table, key: resolved };
    });

    const seen = new Set<string>();
    const existence = new Map<string, boolean>();
    for (const { table, key } of keys) {
      const cacheKey = `${table}/${key}`;
      if (seen.has(cacheKey)) continue;
      seen.add(cacheKey);
      if (
        appliedPaths.has(`${table}:${key}`) ||
        appliedPaths.has(`${table}/${key}`)
      ) {
        existence.set(cacheKey, true);
        continue;
      }
      const exists = await backend.recordExists(table, key);
      existence.set(cacheKey, exists);
    }
    for (const [k, ok] of existence) {
      if (!ok) {
        throw SeedError.coded(
          "E_REF_MISSING",
          `seed ${JSON.stringify(seedName)} references ${k} but no such record exists`,
        );
      }
    }
    return rewriteRefs(value, backendName, fieldToKey);
  }

  /**
   * Snapshot donor entries (with the contested paths removed) for any
   * tracking entry that currently claims one of `newPaths` and is not
   * the new owner. Caller upserts each one.
   */
  private findDonors(
    newOwner: string,
    newPaths: string[],
    tracked: Map<string, TrackingEntry>,
  ): Map<string, TrackingEntry> {
    const out = new Map<string, TrackingEntry>();
    for (const path of newPaths) {
      for (const [donorName, donor] of tracked) {
        if (donorName === newOwner) continue;
        if (!donor.pathsTouched.includes(path)) continue;
        const modified =
          out.get(donorName) ??
          { ...donor, pathsTouched: [...donor.pathsTouched] };
        modified.pathsTouched = modified.pathsTouched.filter((p) => p !== path);
        out.set(donorName, modified);
      }
    }
    return out;
  }

  private transferPairs(
    newOwner: string,
    newPaths: string[],
    tracked: Map<string, TrackingEntry>,
  ): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const path of newPaths) {
      for (const [donorName, donor] of tracked) {
        if (donorName === newOwner) continue;
        if (donor.pathsTouched.includes(path)) {
          out.push([donorName, path]);
        }
      }
    }
    return out;
  }

  private emit(
    level: EventLevel,
    event: string,
    data: Record<string, unknown>,
    seed?: string,
  ): void {
    this.config.emitter.emit(makeEvent(level, event, data, seed));
  }
}

// ────────────────── pure helpers (sync) for ref walker ──────────────────

/**
 * Walk a dot-notation path into a JSON value (spec §13.4 ext) — same
 * semantics as the Rust `walk_dotted_path` helper. Returns
 * `undefined` for any miss; a `null` leaf is returned as `null`
 * (caller distinguishes if needed). Field names containing literal
 * dots aren't supported.
 */
function walkDottedPath(value: unknown, path: string): unknown {
  if (path === "") return value;
  let cursor = value;
  for (const seg of path.split(".")) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[seg];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

function collectRefTargets(value: unknown, out: RefTarget[]): void {
  const m = asRefMarker(value);
  if (m) {
    out.push(m);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectRefTargets(v, out);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectRefTargets(v, out);
    }
  }
}

/**
 * Replace every `$ref` marker with its wire form (spec §7.1):
 * - `kind: "key"` → `table/key` (Firestore) or `table:key` (SurrealDB)
 *   — historical path-string for path-typed fields.
 * - `kind: "field"` → bare resolved key string — for id-typed fields
 *   that store the target's doc key verbatim.
 *
 * `fieldToKey` provides the resolved doc keys for field-form refs
 * (resolved earlier async).
 */
function rewriteRefs(
  value: unknown,
  backendName: string,
  fieldToKey: Map<string, string>,
): unknown {
  const m = asRefMarker(value);
  if (m) {
    if (m.kind === "key") {
      return backendName === "surrealdb"
        ? `${m.table}:${m.key}`
        : `${m.table}/${m.key}`;
    }
    const cacheKey = `${m.table}|${m.field}|${m.value}`;
    const resolved = fieldToKey.get(cacheKey);
    if (resolved === undefined) {
      throw new Error("rewriteRefs: field-form ref not in resolved cache");
    }
    return resolved;
  }
  if (Array.isArray(value)) {
    return value.map((v) => rewriteRefs(v, backendName, fieldToKey));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteRefs(v, backendName, fieldToKey);
    }
    return out;
  }
  return value;
}
