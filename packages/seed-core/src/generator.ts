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
