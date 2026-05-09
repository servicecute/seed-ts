/**
 * CLI verb surface (spec §11.1). Implemented as a plain
 * discriminated-union type — TS services typically wrap with their
 * own commander/clipanion CLI and dispatch through `runCommand`.
 *
 * Bodies throw "not implemented yet" until the runner verbs land.
 */

import type { DbBackend } from "./backend.js";
import type { LockVerb } from "./lock.js";
import { type SeedRunner, type SeedState } from "./runner.js";
import {
  type EventEmitter,
  StdoutNdjsonEmitter,
  TextEmitter,
} from "./event.js";
import { exitCodeFor, SeedError } from "./error.js";

export type OutputFormat = "json" | "text";

/**
 * Spec §11.2: optional `--scope <name>` flag. When set, the runner
 * routes every backend resolution through `ScopedBackends` for that
 * label rather than the configured `scopeTarget`. `undefined` keeps the
 * existing config-driven scope.
 */
export type SeedCommand =
  | {
      kind: "apply";
      names: string[];
      all: boolean;
      force: boolean;
      yes: boolean;
      dryRun: boolean;
      format: OutputFormat;
      scope?: string;
    }
  | {
      kind: "regenerate";
      names: string[];
      all: boolean;
      yes: boolean;
      dryRun: boolean;
      format: OutputFormat;
      scope?: string;
    }
  | { kind: "status"; format: OutputFormat; scope?: string }
  | { kind: "list"; format: OutputFormat }
  | {
      kind: "reset";
      names: string[];
      all: boolean;
      sudo: boolean;
      cascade: boolean;
      yes: boolean;
      dryRun: boolean;
      format: OutputFormat;
      scope?: string;
    }
  | {
      kind: "prune";
      sudo: boolean;
      cascade: boolean;
      dryRun: boolean;
      yes: boolean;
      format: OutputFormat;
      scope?: string;
    }
  | { kind: "validate"; names: string[]; format: OutputFormat; scope?: string }
  | { kind: "forceUnlock"; verb: LockVerb; scope?: string }
  | { kind: "exportRegistry" };

export function emitterFor(format: OutputFormat): EventEmitter {
  return format === "text" ? new TextEmitter() : new StdoutNdjsonEmitter();
}

/**
 * Parse `process.argv.slice(2)` (or a supplied argv array) into a
 * {@link SeedCommand} and run it against the supplied runner.
 *
 * This is the entry-point for services that want a zero-boilerplate
 * seed CLI — just call `dispatchArgv(runner)` from a `seed.ts` script:
 *
 * ```ts
 * #!/usr/bin/env bun
 * import { SeedRunner } from '@servicecute/seed-core';
 * import { SurrealBackend } from '@servicecute/surrealdb-seed';
 * import { buildSeedConfig } from '@/seed/registry';
 * import { dispatchArgv } from '@servicecute/seed-core';
 * import { db } from '@/services/database';
 *
 * await db.connect();
 * const config = await buildSeedConfig(process.env.SEED_SCOPE ?? 'development', process.argv.join(' '));
 * const runner = new SeedRunner(config);
 * process.exit(await dispatchArgv(runner));
 * ```
 *
 * Supported verbs: apply, reset, status, list, validate, prune,
 * force-unlock, export-registry.
 */
export async function dispatchArgv<B extends DbBackend>(
  runner: SeedRunner<B>,
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const cmd = parseArgv(argv);
  if (!cmd) {
    printHelp();
    return 1;
  }
  return runCommand(runner, cmd);
}

/** Exported for unit testing only. */
export const parseArgvForTest = parseArgv;

function parseArgv(argv: string[]): SeedCommand | undefined {
  const verb = argv[0];
  const rest = argv.slice(1);

  const flag = (name: string) => rest.includes(`--${name}`);
  const opt = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    return i !== -1 ? rest[i + 1] : undefined;
  };
  const names = rest.filter(a => !a.startsWith('--'));
  const format: OutputFormat = opt('format') === 'text' ? 'text' : 'json';
  const scope = opt('scope');

  switch (verb) {
    case 'apply':
      return { kind: 'apply', names, all: flag('all'), force: flag('force'), yes: flag('yes'), dryRun: flag('dry-run'), format, scope };
    case 'reset':
      return { kind: 'reset', names, all: flag('all'), sudo: flag('sudo'), cascade: flag('cascade'), yes: flag('yes'), dryRun: flag('dry-run'), format, scope };
    case 'status':
      return { kind: 'status', format, scope };
    case 'list':
      return { kind: 'list', format };
    case 'validate':
      return { kind: 'validate', names, format, scope };
    case 'prune':
      return { kind: 'prune', sudo: flag('sudo'), cascade: flag('cascade'), dryRun: flag('dry-run'), yes: flag('yes'), format, scope };
    case 'force-unlock': {
      const verbArg = rest.find(a => !a.startsWith('--')) ?? 'apply';
      return { kind: 'forceUnlock', verb: verbArg === 'regenerate' ? 'regenerate' : 'apply', scope };
    }
    case 'export-registry':
      return { kind: 'exportRegistry' };
    default:
      return undefined;
  }
}

function printHelp(): void {
  process.stderr.write(`Usage: seed <verb> [options]

Verbs:
  apply [names...] [--all] [--force] [--yes] [--dry-run] [--scope <s>]
  reset [names...] [--all] [--sudo] [--cascade] [--yes] [--dry-run] [--scope <s>]
  status [--scope <s>]
  list
  validate [names...] [--scope <s>]
  prune [--sudo] [--cascade] [--dry-run] [--yes] [--scope <s>]
  force-unlock [apply|regenerate] [--scope <s>]
  export-registry

Options:
  --format json|text   Output format (default: json)
  --scope <name>       Override scope for this call
`);
}

/**
 * Run a parsed {@link SeedCommand} against a runner. Returns the exit
 * code the host binary should pass to `process.exit` (§11.3).
 *
 * **Stub** — most branches throw until the corresponding runner
 * methods land.
 */
export async function runCommand<B extends DbBackend>(
  runner: SeedRunner<B>,
  cmd: SeedCommand,
): Promise<number> {
  try {
    await dispatch(runner, cmd);
    return 0;
  } catch (e) {
    const err = e instanceof SeedError ? e : undefined;
    process.stderr.write(`seed: ${(e as Error).message}\n`);
    return exitCodeFor(err?.code);
  }
}

async function dispatch<B extends DbBackend>(
  runner: SeedRunner<B>,
  cmd: SeedCommand,
): Promise<void> {
  switch (cmd.kind) {
    case "apply": {
      const names = effectiveNames(cmd.names, cmd.all);
      if (cmd.dryRun) {
        await (cmd.scope
          ? runner.validateWithScope(names, cmd.scope)
          : runner.validate(names));
        return;
      }
      if (cmd.force) {
        await (cmd.scope
          ? runner.applyForceWithScope(names, cmd.scope)
          : runner.applyForce(names));
        return;
      }
      await (cmd.scope
        ? runner.applyWithScope(names, cmd.scope)
        : runner.apply(names));
      return;
    }
    case "regenerate":
      // Regenerate composes apply+reset under the hood; the scope
      // override flows through whichever inner verb is used.
      await runner.regenerate(effectiveNames(cmd.names, cmd.all));
      return;
    case "status": {
      const entries = await (cmd.scope
        ? runner.statusWithScope(cmd.scope)
        : runner.status());
      for (const e of entries) {
        process.stdout.write(`${e.name}\t${labelState(e.state)}\n`);
      }
      return;
    }
    case "list":
      for (const s of runner.list()) {
        process.stdout.write(
          `${s.name}\tscope=${JSON.stringify(s.scope)}\tdependsOn=${JSON.stringify(s.dependsOn)}\trequires=${JSON.stringify(s.requires)}\n`,
        );
      }
      return;
    case "reset":
      if (cmd.dryRun) {
        process.stdout.write(
          `dry-run reset: names=${JSON.stringify(cmd.names)} all=${cmd.all} cascade=${cmd.cascade}\n`,
        );
        return;
      }
      if (!cmd.yes && !(await confirmReset(cmd.all, cmd.cascade, cmd.names))) {
        throw SeedError.coded(
          "E_RESET_RESTRICTED",
          "reset aborted by operator",
        );
      }
      if (cmd.all) {
        await (cmd.scope
          ? runner.resetAllWithScope(cmd.sudo, cmd.scope)
          : runner.resetAll(cmd.sudo));
      } else {
        await (cmd.scope
          ? runner.resetWithScope(cmd.names, cmd.cascade, cmd.sudo, cmd.scope)
          : runner.reset(cmd.names, cmd.cascade, cmd.sudo));
      }
      return;
    case "prune": {
      const dry = await (cmd.scope
        ? runner.pruneWithScope(false, cmd.cascade, true, cmd.scope)
        : runner.prune(false, cmd.cascade, true));
      if (dry.length === 0) {
        process.stdout.write("seed prune: no orphaned tracking entries.\n");
        return;
      }
      if (cmd.dryRun) {
        for (const n of dry) process.stdout.write(`would prune: ${n}\n`);
        return;
      }
      if (!cmd.yes && !(await confirmPrune(dry, cmd.cascade))) {
        throw SeedError.coded("E_RESET_RESTRICTED", "prune aborted by operator");
      }
      const pruned = await (cmd.scope
        ? runner.pruneWithScope(cmd.sudo, cmd.cascade, false, cmd.scope)
        : runner.prune(cmd.sudo, cmd.cascade, false));
      for (const n of pruned) process.stdout.write(`pruned: ${n}\n`);
      return;
    }
    case "validate":
      await (cmd.scope
        ? runner.validateWithScope(cmd.names, cmd.scope)
        : runner.validate(cmd.names));
      return;
    case "forceUnlock":
      await (cmd.scope
        ? runner.forceUnlockWithScope(cmd.verb, cmd.scope)
        : runner.forceUnlock(cmd.verb));
      return;
    case "exportRegistry":
      process.stdout.write(runner.exportRegistry() + "\n");
      return;
  }
}

function effectiveNames(names: string[], all: boolean): string[] {
  return all ? [] : names;
}

function labelState(state: SeedState): string {
  switch (state.kind) {
    case "pending":
      return "pending";
    case "applied":
      return "applied";
    case "drifted":
      return "drifted";
    case "orphaned":
      return "orphaned (❓)";
  }
}

async function confirmReset(
  all: boolean,
  cascade: boolean,
  names: string[],
): Promise<boolean> {
  if (all) {
    process.stderr.write(
      "About to reset every applied seed in reverse topological order (cascade=true).\n",
    );
  } else {
    process.stderr.write(
      `About to reset ${names.length} seed(s): ${JSON.stringify(names)} (cascade=${cascade}).\n`,
    );
  }
  process.stderr.write(
    "This deletes the records each seed wrote. Tracking entries are removed.\n",
  );
  return promptYesNo("Proceed?");
}

async function confirmPrune(names: string[], cascade: boolean): Promise<boolean> {
  process.stderr.write(
    `About to prune ${names.length} orphaned tracking entr${names.length === 1 ? "y" : "ies"} (cascade=${cascade}):\n`,
  );
  for (const n of names) process.stderr.write(`  - ${n}\n`);
  if (cascade) {
    process.stderr.write(
      "With --cascade, the underlying records will also be deleted.\n",
    );
  }
  return promptYesNo("Proceed?");
}

async function promptYesNo(message: string): Promise<boolean> {
  process.stderr.write(`${message} [y/N] `);
  const chunks: Buffer[] = [];
  return new Promise<boolean>((resolve) => {
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const newlineIdx = buf.indexOf(0x0a);
      if (newlineIdx === -1) return;
      process.stdin.off("data", onData);
      const line = buf.subarray(0, newlineIdx).toString("utf8").trim().toLowerCase();
      resolve(line === "y" || line === "yes");
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", () => resolve(false));
  });
}
