import { describe, expect, it } from "bun:test";
import {
  asRefMarker,
  refMarkerByField,
  refMarkerByEmail,
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
  // §4.1 v0.6.1: names that identify external entities (e.g.
  // Firestore collections like `groupMembers`) are permitted.
  it("accepts camelCase for collection-shaped names", () => {
    const r = new Registry<number>();
    expect(() => r.register("groupMembers", 1)).not.toThrow();
    expect(r.lookup("groupMembers")).toBe(1);
  });

  it("rejects names with leading digit", () => {
    const r = new Registry<number>();
    expect(() => r.register("1foo", 1)).toThrow(/must match/);
  });

  it("rejects whitespace or special chars", () => {
    const r = new Registry<number>();
    expect(() => r.register("foo bar", 1)).toThrow(/must match/);
    expect(() => r.register("foo$bar", 2)).toThrow(/must match/);
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
  it("recognises the direct-key shape", () => {
    const m = refMarker("users", "alice");
    expect(asRefMarker(m)).toEqual({
      kind: "key",
      table: "users",
      key: "alice",
    });
  });

  it("recognises the email sugar (2-field) and desugars to field form", () => {
    const m = refMarkerByEmail("users", "alice@x.com");
    expect(asRefMarker(m)).toEqual({
      kind: "field",
      table: "users",
      field: "email",
      value: "alice@x.com",
    });
  });

  it("recognises the generic 3-field shape", () => {
    const m = refMarkerByField("products", "slug", "leather-wallet");
    expect(asRefMarker(m)).toEqual({
      kind: "field",
      table: "products",
      field: "slug",
      value: "leather-wallet",
    });
  });

  it("rejects extra keys on outer", () => {
    expect(asRefMarker({ $ref: { table: "u", key: "a" }, extra: 1 })).toBeUndefined();
  });

  it("rejects 4-field inner", () => {
    expect(
      asRefMarker({
        $ref: { table: "u", field: "email", value: "X", extra: 1 },
      }),
    ).toBeUndefined();
  });

  it("rejects 2-field inner without key or email", () => {
    expect(asRefMarker({ $ref: { table: "u", phone: "X" } })).toBeUndefined();
  });

  it("rejects 3-field inner missing field or value", () => {
    expect(
      asRefMarker({ $ref: { table: "u", field: "email", data: "X" } }),
    ).toBeUndefined();
  });

  it("rejects wrong wrapper key", () => {
    expect(asRefMarker({ ref: { table: "u", key: "a" } })).toBeUndefined();
  });
});
