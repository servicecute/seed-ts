import type { DbBackend } from "./backend.js";
import { SeedError } from "./error.js";
import {
  type EventEmitter,
  StdoutNdjsonEmitter,
} from "./event.js";
import { type GeneratorRegistry, PricingRegistry } from "./generator.js";
import { Registry } from "./registry.js";
import type { SchemaRegistry, SchemaEntry } from "./schema.js";
import {
  type SeedRegistry,
  type SeedActionRegistry,
  type Seed,
} from "./seed.js";
import type { TrackingEntry } from "./tracking.js";
import type { TransformerRegistry } from "./transformer.js";

export interface CostCaps {
  perSeedUsd?: number;
  perRunUsd?: number;
}

export interface SeedConfigOpts<B extends DbBackend> {
  backend: B;
  scopeTarget?: string;
  lockTtlMs?: number;
  generatorTimeoutMs?: number;
  validationThreshold?: number;
  costCaps?: CostCaps;
  emitter?: EventEmitter;
  specVersion?: string;
  holderLabel?: string;
}

export class SeedConfig<B extends DbBackend> {
  readonly backend: B;
  readonly seeds: SeedRegistry = new Registry<Seed>();
  readonly actions: SeedActionRegistry = new Registry();
  readonly schemas: SchemaRegistry = new Registry<SchemaEntry>();
  readonly transformers: TransformerRegistry = new Registry();
  readonly generators: GeneratorRegistry = new Registry();
  readonly pricing: PricingRegistry = new PricingRegistry();
  scopeTarget: string;
  lockTtlMs: number;
  generatorTimeoutMs: number;
  validationThreshold: number;
  costCaps: CostCaps;
  emitter: EventEmitter;
  specVersion: string;
  holderLabel: string;

  constructor(opts: SeedConfigOpts<B>) {
    this.backend = opts.backend;
    this.scopeTarget = opts.scopeTarget ?? "";
    this.lockTtlMs = opts.lockTtlMs ?? 5 * 60 * 1000;
    this.generatorTimeoutMs = opts.generatorTimeoutMs ?? 60 * 1000;
    this.validationThreshold = opts.validationThreshold ?? 0.2;
    this.costCaps = opts.costCaps ?? {};
    this.emitter = opts.emitter ?? new StdoutNdjsonEmitter();
    this.specVersion = opts.specVersion ?? "0.4.1";
    this.holderLabel = opts.holderLabel ?? "";
  }
}

/** Runner status enumeration (spec §5, §10.6). */
export type SeedState =
  | { kind: "pending" }
  | { kind: "applied"; keyHash: string; appliedAt: string }
  | { kind: "drifted"; trackedHash: string; currentHash: string }
  | {
      kind: "orphaned";
      appliedAt: string;
      pathsTouched: string[];
    };

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

/**
 * The seed runner. **All verb bodies throw `not implemented yet` —
 * full orchestration lands in T1.x / T2.x of `seed-ts/tasks.md`.**
 *
 * The shape (config, registries, public API surface) is fixed so
 * downstream services can import the runner today and have its API
 * resolve at type-check time.
 */
export class SeedRunner<B extends DbBackend> {
  readonly config: SeedConfig<B>;

  constructor(config: SeedConfig<B>) {
    this.config = config;
  }

  apply(_names: string[]): Promise<void> {
    return Promise.reject(
      SeedError.coded("E_INTERNAL", "SeedRunner.apply not yet implemented (T2.7)"),
    );
  }

  applyForce(_names: string[]): Promise<void> {
    return Promise.reject(
      SeedError.coded("E_INTERNAL", "SeedRunner.applyForce not yet implemented (T2.7)"),
    );
  }

  reset(_names: string[], _cascade: boolean, _sudo: boolean): Promise<void> {
    return Promise.reject(
      SeedError.coded("E_INTERNAL", "SeedRunner.reset not yet implemented (T3.1)"),
    );
  }

  resetAll(_sudo: boolean): Promise<void> {
    return Promise.reject(
      SeedError.coded("E_INTERNAL", "SeedRunner.resetAll not yet implemented (T3.1)"),
    );
  }

  status(): Promise<SeedStatus[]> {
    return Promise.reject(
      SeedError.coded("E_INTERNAL", "SeedRunner.status not yet implemented (T3.3)"),
    );
  }

  list(): SeedSummary[] {
    throw SeedError.coded("E_INTERNAL", "SeedRunner.list not yet implemented (T3.4)");
  }

  validate(_names: string[]): Promise<void> {
    return Promise.reject(
      SeedError.coded("E_INTERNAL", "SeedRunner.validate not yet implemented (T3.5)"),
    );
  }

  prune(_sudo: boolean, _cascade: boolean, _dryRun: boolean): Promise<string[]> {
    return Promise.reject(
      SeedError.coded("E_INTERNAL", "SeedRunner.prune not yet implemented (T3.7)"),
    );
  }

  forceUnlock(_verb: "apply" | "regenerate"): Promise<void> {
    return Promise.reject(
      SeedError.coded("E_INTERNAL", "SeedRunner.forceUnlock not yet implemented (T3.6)"),
    );
  }

  regenerate(_names: string[]): Promise<void> {
    return Promise.reject(
      SeedError.coded("E_INTERNAL", "SeedRunner.regenerate not yet implemented (T12)"),
    );
  }

  exportRegistry(): string {
    throw SeedError.coded(
      "E_INTERNAL",
      "SeedRunner.exportRegistry not yet implemented (T6.4)",
    );
  }
}

/** Spec §9.1: scope gate (export so consumers can validate at registration). */
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
