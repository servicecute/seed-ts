import { describe, expect, it } from "bun:test";
import {
  type GeneratorContext,
  LlmGenerator,
  type LlmCompletionRequest,
  type LlmCompletionResponse,
  type LlmProvider,
  PricingRegistry,
  type SchemaEntry,
  stripMarkdownFences,
} from "../src/index.js";

class StubProvider implements LlmProvider {
  constructor(
    private readonly canned: string,
    private readonly usage?: { prompt: number; completion: number },
  ) {}
  name(): string {
    return "stub";
  }
  async complete(_: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    return {
      content: this.canned,
      model: "stub-model",
      usage: this.usage,
    };
  }
}

function dummySchema(): SchemaEntry {
  return {
    name: "users",
    version: "1",
    source: "code",
    backend: {},
    schema: { type: "object" },
  };
}

function ctx(maxRecords: number, model: string): GeneratorContext {
  return {
    schemaName: "users",
    schema: dummySchema(),
    prompt: "Generate users.",
    maxRecords,
    maxTokens: 1000,
    timeoutMs: 60_000,
    validationThreshold: 0.2,
    params: { model, temperature: 0.2 },
  };
}

describe("LlmGenerator", () => {
  it("parses a clean JSON array response", async () => {
    const provider = new StubProvider(
      `[{"email":"a@x"},{"email":"b@x"}]`,
      { prompt: 100, completion: 50 },
    );
    const gen = new LlmGenerator("llm-stub", provider);
    const out = await gen.generate(ctx(2, "any-model"));
    expect(out.records.length).toBe(2);
    expect(out.tokens?.prompt).toBe(100);
  });

  it("strips markdown fences before parsing", async () => {
    const provider = new StubProvider("```json\n[{\"email\":\"a@x\"}]\n```");
    const gen = new LlmGenerator("llm-stub", provider);
    const out = await gen.generate(ctx(1, "any-model"));
    expect(out.records.length).toBe(1);
  });

  it("rejects a non-array response", async () => {
    const provider = new StubProvider(`{"email":"a@x"}`);
    const gen = new LlmGenerator("llm-stub", provider);
    await expect(gen.generate(ctx(1, "any-model"))).rejects.toThrow(
      /expected JSON array/,
    );
  });

  it("requires `params.model`", async () => {
    const provider = new StubProvider(`[]`);
    const gen = new LlmGenerator("llm-stub", provider);
    const c = ctx(1, "ignored");
    c.params = {};
    await expect(gen.generate(c)).rejects.toThrow(/params\.model/);
  });

  it("computes actualCostUsd from pricing + token usage", async () => {
    const provider = new StubProvider(`[]`, { prompt: 100, completion: 50 });
    const pricing = new PricingRegistry();
    pricing.register("stub", "any-model", {
      promptUsd: 0.01,
      completionUsd: 0.03,
    });
    const gen = new LlmGenerator("llm-stub", provider, { pricing });
    const out = await gen.generate(ctx(1, "any-model"));
    // 100 * 0.01 + 50 * 0.03 = 2.5
    expect(out.actualCostUsd).toBeCloseTo(2.5, 5);
  });

  it("estimateCost returns undefined without pricing", () => {
    const gen = new LlmGenerator("llm-stub", new StubProvider("[]"));
    expect(gen.estimateCost(ctx(1, "any-model"))).toBeUndefined();
  });
});

describe("stripMarkdownFences", () => {
  it("strips ```json fences", () => {
    expect(stripMarkdownFences("```json\n[1,2]\n```")).toBe("[1,2]");
  });
  it("strips bare ``` fences", () => {
    expect(stripMarkdownFences("```\n[1,2]\n```")).toBe("[1,2]");
  });
  it("is a no-op when no fence is present", () => {
    expect(stripMarkdownFences("[1,2]")).toBe("[1,2]");
  });
});
