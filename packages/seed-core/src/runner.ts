import {
  type DbBackend,
  type WriteRequest,
} from "./backend.js";
import { SeedError } from "./error.js";
import {
  type EventEmitter,
  type EventLevel,
  StdoutNdjsonEmitter,
  makeEvent,
} from "./event.js";
import { type GeneratorRegistry, PricingRegistry } from "./generator.js";
import {
  type LockClaim,
  type LockHolder,
  type LockVerb,
} from "./lock.js";
import { Registry } from "./registry.js";
import {
  compile,
  registryToJson as registryToJsonImported,
  type SchemaEntry,
  type SchemaRegistry,
} from "./schema.js";
import {
  asRefMarker,
  topologicalOrder,
  type OwnedWrite,
  type Seed,
  type SeedActionRegistry,
  type SeedRegistry,
} from "./seed.js";
import type { TrackingEntry } from "./tracking.js";
import {
  resolveMarkers,
  type TransformerRegistry,
} from "./transformer.js";

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

/** Public seed runner. Drives every spec verb. */
export class SeedRunner<B extends DbBackend> {
  readonly config: SeedConfig<B>;

  constructor(config: SeedConfig<B>) {
    this.config = config;
  }

  /**
   * Apply named seeds in topological order (§13.6). Empty `names`
   * applies every registered seed. Acquires the apply-class lock
   * (§8.4) before any writes and spawns a heartbeat at TTL/3.
   */
  apply(names: string[]): Promise<void> {
    return this.dispatch("apply", names, false);
  }

  /** Same as `apply` but with `--force` semantics (§11.1). */
  applyForce(names: string[]): Promise<void> {
    return this.dispatch("apply", names, true);
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
    await this.dispatchReset(names, cascade, false);
  }

  /** Reset every applied seed; `--cascade` is implied (§13.2). */
  async resetAll(sudo: boolean): Promise<void> {
    if (!sudo) {
      throw SeedError.coded(
        "E_RESET_RESTRICTED",
        "seed reset --all requires --sudo (§11.2)",
      );
    }
    await this.dispatchReset([], true, true);
  }

  /** Spec §11.1: applied / pending / drifted / orphaned snapshot. */
  async status(): Promise<SeedStatus[]> {
    await this.config.backend.setup();
    const tracked = await this.config.backend.tracking().list();
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
    const started = Date.now();
    this.emit("info", "runner.starting", {
      verb: "validate",
      args: names,
      format: "json",
      backend: this.config.backend.name(),
      scope_target: this.config.scopeTarget,
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
        checkScope(seed, this.config.scopeTarget);
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
    if (!sudo && !dryRun) {
      throw SeedError.coded(
        "E_RESET_RESTRICTED",
        "seed prune requires --sudo (§11.2)",
      );
    }
    await this.config.backend.setup();
    const tracked = await this.config.backend.tracking().list();
    const orphans = tracked.filter((t) => !this.config.seeds.lookup(t.name));
    const names = orphans.map((t) => t.name);
    if (dryRun) return names;

    const holder = buildHolder(this.config.holderLabel);
    const claim = await this.config.backend.lock().acquire(
      "apply",
      holder,
      this.config.lockTtlMs,
    );
    const guard = new LockGuard(
      this.config.backend,
      claim,
      Math.max(1000, Math.floor(this.config.lockTtlMs / 3)),
    );
    try {
      for (const orphan of orphans) {
        if (cascade) {
          await this.config.backend.deletePaths(orphan.pathsTouched);
        }
        await this.config.backend.tracking().remove(orphan.name);
      }
    } finally {
      await guard.release();
    }
    return names;
  }

  async forceUnlock(verb: LockVerb): Promise<void> {
    await this.config.backend.setup();
    await this.config.backend.lock().forceUnlock(verb);
  }

  regenerate(_names: string[]): Promise<void> {
    return Promise.reject(
      SeedError.coded(
        "E_INTERNAL",
        "SeedRunner.regenerate not yet implemented (T12)",
      ),
    );
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
  ): Promise<void> {
    const started = Date.now();
    this.emit("info", "runner.starting", {
      verb: "reset",
      args: names,
      format: "json",
      backend: this.config.backend.name(),
      scope_target: this.config.scopeTarget,
      cascade,
      all,
    });

    let result: { removed: number; skipped: number };
    try {
      result = await this.dispatchResetInner(names, cascade, all);
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
    names: string[],
    cascade: boolean,
    all: boolean,
  ): Promise<{ removed: number; skipped: number }> {
    for (const name of this.config.seeds.names()) {
      rejectProductionScope(this.config.seeds.lookup(name)!);
    }

    await this.config.backend.setup();

    const tracked = await this.config.backend.tracking().list();
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
    const claim = await this.config.backend.lock().acquire(
      "apply",
      holder,
      this.config.lockTtlMs,
    );
    const guard = new LockGuard(
      this.config.backend,
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
        const { deleted, missing } = await this.config.backend.deletePaths(
          entry.pathsTouched,
        );
        for (const path of missing) {
          this.emit("warn", "seed.reset.path_missing", { path_key: path }, name);
        }
        await this.config.backend.tracking().remove(name);
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

  private async dispatch(verb: string, names: string[], force: boolean): Promise<void> {
    const started = Date.now();
    const backendName = this.config.backend.name();
    this.emit("info", "runner.starting", {
      verb,
      args: names,
      format: "json",
      backend: backendName,
      scope_target: this.config.scopeTarget,
      force,
    });

    let result: { applied: number; skipped: number };
    try {
      result = await this.dispatchInner(names, force);
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

    // §10: ensure tracking + lock storage exist before first read.
    await this.config.backend.setup();

    // §8.4: acquire the apply-class advisory lock + heartbeat.
    const holder = buildHolder(this.config.holderLabel);
    const claim = await this.config.backend.lock().acquire(
      "apply",
      holder,
      this.config.lockTtlMs,
    );
    const guard = new LockGuard(
      this.config.backend,
      claim,
      Math.max(1000, Math.floor(this.config.lockTtlMs / 3)),
    );

    try {
      return await this.applyLoop(topo, targetSet, force);
    } finally {
      await guard.release();
    }
  }

  private async applyLoop(
    topo: string[],
    targetSet: Set<string>,
    force: boolean,
  ): Promise<{ applied: number; skipped: number }> {
    let applied = 0;
    let skipped = 0;

    // Snapshot existing tracking once. Mutates as we apply seeds —
    // drift skips short-circuit, ownership transfer (§8.2) moves
    // paths between entries.
    const snapshot = await this.config.backend.tracking().list();
    const trackedByName: Map<string, TrackingEntry> = new Map(
      snapshot.map((t) => [t.name, t]),
    );

    for (const name of topo) {
      if (!targetSet.has(name)) continue;
      const seed = this.config.seeds.lookup(name)!;

      // §9: scope gate.
      try {
        checkScope(seed, this.config.scopeTarget);
      } catch (e) {
        this.emit(
          "error",
          "seed.scope_violation",
          {
            declared_scope: seed.scope,
            actual_scope: this.config.scopeTarget,
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

      // Run the seed's action (if registered) to produce writes.
      const action = this.config.actions.lookup(name);
      const raw: OwnedWrite[] = action ? await action.produce() : [];

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
          name,
          record.data,
          this.config.backend.name(),
          appliedPaths,
        );
      }

      // §13.4: pre-check declared UNIQUE constraints.
      for (const unique of seed.constraints?.unique ?? []) {
        for (const record of owned) {
          if (record.table !== unique.path) continue;
          const data = record.data as Record<string, unknown> | null;
          if (!data || typeof data !== "object") continue;
          if (!(unique.field in data)) continue;
          const value = (data as Record<string, unknown>)[unique.field];
          const conflicts = await this.config.backend.findUniqueConflicts(
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
      const writeResult = await this.config.backend.upsertBatch(writes);

      // §10.1 / §17.3: paths_touched is canonically lex-sorted.
      const pathsTouched = Array.from(new Set(writeResult.pathsTouched)).sort();

      // §8.2: cross-seed ownership transfer. Move paths off any donor
      // tracking entry that currently claims them.
      const donors = this.findDonors(name, pathsTouched, trackedByName);
      for (const [donorName, donorEntry] of donors) {
        await this.config.backend.tracking().upsert(donorEntry);
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
      };
      await this.config.backend.tracking().upsert(entry);
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
    }

    return { applied, skipped };
  }

  private async resolveRefsIn(
    seedName: string,
    value: unknown,
    backendName: string,
    appliedPaths: Set<string>,
  ): Promise<unknown> {
    const refs: Array<{ table: string; key: string }> = [];
    collectRefTargets(value, refs);
    if (refs.length === 0) return rewriteRefs(value, backendName);

    const seen = new Set<string>();
    const existence = new Map<string, boolean>();
    for (const r of refs) {
      const cacheKey = `${r.table}/${r.key}`;
      if (seen.has(cacheKey)) continue;
      seen.add(cacheKey);
      if (
        appliedPaths.has(`${r.table}:${r.key}`) ||
        appliedPaths.has(`${r.table}/${r.key}`)
      ) {
        existence.set(cacheKey, true);
        continue;
      }
      const exists = await this.config.backend.recordExists(r.table, r.key);
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
    return rewriteRefs(value, backendName);
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

function collectRefTargets(
  value: unknown,
  out: Array<{ table: string; key: string }>,
): void {
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

function rewriteRefs(value: unknown, backendName: string): unknown {
  const m = asRefMarker(value);
  if (m) {
    return backendName === "surrealdb" ? `${m.table}:${m.key}` : `${m.table}/${m.key}`;
  }
  if (Array.isArray(value)) {
    return value.map((v) => rewriteRefs(v, backendName));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteRefs(v, backendName);
    }
    return out;
  }
  return value;
}
