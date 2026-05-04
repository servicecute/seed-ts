import { describe, expect, it } from "bun:test";
import {
  asRefMarker,
  hashCanonical,
  refMarker,
  Registry,
  topologicalOrder,
  type Seed,
} from "../src/index.js";

function seed(name: string, deps: string[] = []): Seed {
  return {
    name,
    scope: ["development"],
    dependsOn: deps,
    requires: [],
    requiresSchemas: {},
    keyHash: "",
  };
}

describe("topologicalOrder", () => {
  it("emits the spec §13.6 worked example with alphabetical tie-break", () => {
    const r = new Registry<Seed>();
    r.register("baseline-users", seed("baseline-users"));
    r.register("demo-tenants", seed("demo-tenants", ["baseline-users"]));
    r.register("billing-defaults", seed("billing-defaults", ["baseline-users"]));
    r.register("support-tickets", seed("support-tickets", ["demo-tenants"]));
    r.register(
      "marketplace-listings",
      seed("marketplace-listings", ["demo-tenants", "billing-defaults"]),
    );
    expect(topologicalOrder(r)).toEqual([
      "baseline-users",
      "billing-defaults",
      "demo-tenants",
      "marketplace-listings",
      "support-tickets",
    ]);
  });

  it("detects cycles", () => {
    const r = new Registry<Seed>();
    r.register("a", seed("a", ["b"]));
    r.register("b", seed("b", ["a"]));
    expect(() => topologicalOrder(r)).toThrow(/cycle/);
  });

  it("rejects unknown dependencies", () => {
    const r = new Registry<Seed>();
    r.register("a", seed("a", ["ghost"]));
    expect(() => topologicalOrder(r)).toThrow(/undeclared/);
  });
});

describe("hashCanonical", () => {
  it("strips comments and collapses whitespace", () => {
    const a = "fn x() { let y = 1; }";
    const b = "fn x() {\n    // a comment\n    let y = 1;\n}";
    expect(hashCanonical(a)).toBe(hashCanonical(b));
  });

  it("identifier renames change the hash", () => {
    const before = "function alpha() { return 1; }";
    const after = "function beta() { return 1; }";
    expect(hashCanonical(before)).not.toBe(hashCanonical(after));
  });

  it("starts with 'sha256:' (stable format)", () => {
    expect(hashCanonical("anything")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("self-consistency: same source twice yields the same hash", () => {
    const src = "let z = [1, 2, 3].map(n => n * 2);";
    expect(hashCanonical(src)).toBe(hashCanonical(src));
  });
});

describe("Registry", () => {
  it("rejects names not matching [a-z][a-z0-9_-]*", () => {
    const r = new Registry<number>();
    expect(() => r.register("Foo", 1)).toThrow(/must match/);
  });

  it("rejects duplicates", () => {
    const r = new Registry<number>();
    r.register("foo", 1);
    expect(() => r.register("foo", 2)).toThrow(/already has entry/);
  });

  it("lookup returns inserted", () => {
    const r = new Registry<number>();
    r.register("foo", 42);
    expect(r.lookup("foo")).toBe(42);
    expect(r.lookup("bar")).toBeUndefined();
  });
});

describe("refMarker / asRefMarker", () => {
  it("recognises canonical shape", () => {
    const m = refMarker("users", "alice");
    expect(asRefMarker(m)).toEqual({ table: "users", key: "alice" });
  });

  it("rejects extra keys on outer", () => {
    expect(asRefMarker({ $ref: { table: "u", key: "a" }, extra: 1 })).toBeUndefined();
  });

  it("rejects extra keys on inner", () => {
    expect(asRefMarker({ $ref: { table: "u", key: "a", extra: 1 } })).toBeUndefined();
  });

  it("rejects wrong wrapper key", () => {
    expect(asRefMarker({ ref: { table: "u", key: "a" } })).toBeUndefined();
  });
});
