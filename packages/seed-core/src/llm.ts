/**
 * `LlmGenerator` — wraps any {@link LlmProvider} so it satisfies the
 * seed runner's {@link Generator} contract (spec §17.4).
 *
 * Service wiring:
 *
 * ```ts
 * import {
 *   LlmGenerator,
 *   PricingRegistry,
 *   SeedConfig,
 * } from "@servicecute/seed-core";
 * import { AnthropicProvider } from "./my-anthropic-impl";
 *
 * const pricing = new PricingRegistry();
 * pricing.register("anthropic", "claude-3-5-sonnet-20241022", {
 *   promptUsd: 0.000_003,
 *   completionUsd: 0.000_015,
 * });
 *
 * const generator = new LlmGenerator(
 *   "llm-anthropic",
 *   new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
 *   { pricing },
 * );
 * config.generators.register("llm-anthropic", generator);
 * ```
 *
 * Schema-injection-via-system-prompt (spec §17.4 method 1) — works
 * with every provider. Tool/structured-output APIs land later when
 * we want the provider side to enforce shape; runner-side validation
 * already catches drift either way.
 */

import { SeedError } from "./error.js";
import type {
  Generator,
  GeneratorContext,
  GeneratorOutput,
  PricingRegistry,
  TokenUsage,
} from "./generator.js";

export interface LlmCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCompletionRequest {
  model: string;
  messages: LlmCompletionMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface LlmCompletionResponse {
  content: string;
  model: string;
  usage?: TokenUsage;
}

/**
 * Provider seam. Each integration (Anthropic, OpenAI, Google, …)
 * implements this interface; the same {@link LlmGenerator} works
 * against any of them. Mirrors the contract of the Rust
 * `lib_llm::LlmProvider` trait so seed authors switching languages
 * don't have to relearn it.
 */
export interface LlmProvider {
  /** Display name for telemetry + pricing keys. */
  name(): string;
  complete(request: LlmCompletionRequest): Promise<LlmCompletionResponse>;
}

export interface LlmGeneratorOptions {
  /** Optional pricing registry; without it, `estimateCost` returns `undefined`. */
  pricing?: PricingRegistry;
}

export class LlmGenerator implements Generator {
  readonly name: string;
  private readonly provider: LlmProvider;
  private readonly pricing?: PricingRegistry;

  constructor(name: string, provider: LlmProvider, opts: LlmGeneratorOptions = {}) {
    this.name = name;
    this.provider = provider;
    this.pricing = opts.pricing;
  }

  estimateCost(ctx: GeneratorContext): number | undefined {
    if (!this.pricing) return undefined;
    const model = readStringParam(ctx.params, "model");
    if (!model) return undefined;
    const entry = this.pricing.lookup(this.provider.name(), model);
    if (!entry) return undefined;
    // We don't tokenise the prompt; use max_tokens as the upper bound
    // for both directions per spec §17.4.
    const maxTokens = ctx.maxTokens ?? 0;
    return entry.promptUsd * maxTokens + entry.completionUsd * maxTokens;
  }

  async generate(ctx: GeneratorContext): Promise<GeneratorOutput> {
    const model = readStringParam(ctx.params, "model");
    if (!model) {
      throw SeedError.coded(
        "E_GENERATOR_FAILED",
        "LlmGenerator: `params.model` is required (spec §17.4 forbids \"latest\"/\"auto\")",
      );
    }
    const temperature = readNumberParam(ctx.params, "temperature");

    const schemaJson = JSON.stringify(ctx.schema.schema, null, 2);
    const system =
      `You produce records that satisfy a JSON Schema 2020-12 contract.\n` +
      `\n` +
      `Output: a JSON array of at most ${ctx.maxRecords} records.\n` +
      `Each record MUST validate against this schema:\n` +
      `\n` +
      `${schemaJson}\n` +
      `\n` +
      `Return ONLY the JSON array. No commentary, no markdown fences.`;

    const request: LlmCompletionRequest = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: ctx.prompt },
      ],
    };
    if (temperature !== undefined) request.temperature = temperature;
    if (ctx.maxTokens !== undefined) request.maxTokens = ctx.maxTokens;

    let response: LlmCompletionResponse;
    try {
      response = await this.provider.complete(request);
    } catch (e) {
      throw SeedError.coded(
        "E_GENERATOR_FAILED",
        `${this.provider.name()}: ${(e as Error).message}`,
        e,
      );
    }

    const body = stripMarkdownFences(response.content);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw SeedError.coded(
        "E_GENERATOR_FAILED",
        `${this.provider.name()}: response was not valid JSON: ${(e as Error).message}; first 200 chars: ${JSON.stringify(body.slice(0, 200))}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw SeedError.coded(
        "E_GENERATOR_FAILED",
        `${this.provider.name()}: expected JSON array, got ${typeLabel(parsed)}`,
      );
    }

    const tokens = response.usage;
    const pricingEntry = this.pricing?.lookup(this.provider.name(), model);
    const actualCostUsd =
      tokens && pricingEntry
        ? pricingEntry.promptUsd * tokens.prompt +
          pricingEntry.completionUsd * tokens.completion
        : undefined;

    return {
      records: parsed,
      droppedCount: 0,
      tokens,
      actualCostUsd,
    };
  }
}

function readStringParam(params: unknown, key: string): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const v = (params as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function readNumberParam(params: unknown, key: string): number | undefined {
  if (!params || typeof params !== "object") return undefined;
  const v = (params as Record<string, unknown>)[key];
  return typeof v === "number" ? v : undefined;
}

/**
 * Strip a leading ```json (or bare ```) fence and the matching
 * trailing fence. Idempotent — safe to call when no fence is present.
 */
export function stripMarkdownFences(s: string): string {
  let out = s.trim();
  if (out.startsWith("```json")) out = out.slice("```json".length);
  else if (out.startsWith("```")) out = out.slice(3);
  out = out.trimStart();
  if (out.endsWith("```")) out = out.slice(0, -3);
  return out.trim();
}

function typeLabel(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
