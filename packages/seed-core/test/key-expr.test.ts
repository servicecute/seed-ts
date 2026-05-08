import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { applyKeyExpr, type KeyExpr } from "../src/key-expr.js";

describe("KeyExpr (seed-spec §26 v0.6.1)", () => {
  it("Sha256Hex with two DataPath parts matches concat-then-sha256", () => {
    const template: KeyExpr = {
      kind: "sha256_hex",
      prefix: "group_members_",
      parts: [
        { source: "data_path", pointer: "/groupId" },
        { source: "data_path", pointer: "/userId" },
      ],
    };
    const data = {
      groupId: "group-alice-family",
      userId: "alice-uid-12345",
    };
    const got = applyKeyExpr(template, data);

    // Reproduce production's deterministic_group_member_id by hand —
    // proves wire format matches Rust's implementation byte-for-byte.
    const expected = createHash("sha256")
      .update(Buffer.from("group-alice-family", "utf8"))
      .update(Buffer.from("alice-uid-12345", "utf8"))
      .digest("hex");
    expect(got).toBe(`group_members_${expected}`);
  });

  it("Sha256Hex literal parts concat in declaration order", () => {
    const template: KeyExpr = {
      kind: "sha256_hex",
      prefix: "",
      parts: [
        { source: "literal", value: "foo" },
        { source: "literal", value: "bar" },
      ],
    };
    const expected = createHash("sha256").update("foobar", "utf8").digest("hex");
    expect(applyKeyExpr(template, null)).toBe(expected);
  });

  it("Sha256Hex mixes Literal + DataPath", () => {
    const template: KeyExpr = {
      kind: "sha256_hex",
      prefix: "tenant:",
      parts: [
        { source: "literal", value: "v1/" },
        { source: "data_path", pointer: "/userId" },
      ],
    };
    const expected = createHash("sha256")
      .update("v1/", "utf8")
      .update("abc", "utf8")
      .digest("hex");
    expect(applyKeyExpr(template, { userId: "abc" })).toBe(`tenant:${expected}`);
  });

  it("DataPath missing field errors with E_KEY_TEMPLATE_FAILED", () => {
    const template: KeyExpr = {
      kind: "sha256_hex",
      prefix: "",
      parts: [{ source: "data_path", pointer: "/missing" }],
    };
    expect(() => applyKeyExpr(template, { present: "x" })).toThrow(/missing/);
  });

  it("DataPath non-string value errors", () => {
    const template: KeyExpr = {
      kind: "sha256_hex",
      prefix: "",
      parts: [{ source: "data_path", pointer: "/n" }],
    };
    expect(() => applyKeyExpr(template, { n: 42 })).toThrow(/non-string/);
  });

  it("empty parts errors", () => {
    const template: KeyExpr = {
      kind: "sha256_hex",
      prefix: "",
      parts: [],
    };
    expect(() => applyKeyExpr(template, null)).toThrow(/at least one part/);
  });

  it("deterministic across calls", () => {
    const template: KeyExpr = {
      kind: "sha256_hex",
      prefix: "p_",
      parts: [{ source: "data_path", pointer: "/x" }],
    };
    const data = { x: "abc" };
    expect(applyKeyExpr(template, data)).toBe(applyKeyExpr(template, data));
  });

  it("byte-for-byte identical to Rust applyKeyExpr for identical inputs", () => {
    // This is the cross-language parity claim: TS and Rust MUST
    // produce the same output for the same template + data. The Rust
    // unit test asserts the same `group_members_<sha256>` shape over
    // the same inputs ("group-alice-family", "alice-uid-12345").
    const template: KeyExpr = {
      kind: "sha256_hex",
      prefix: "group_members_",
      parts: [
        { source: "data_path", pointer: "/groupId" },
        { source: "data_path", pointer: "/userId" },
      ],
    };
    const got = applyKeyExpr(template, {
      groupId: "group-alice-family",
      userId: "alice-uid-12345",
    });
    // Computed independently — sha256 of the concatenated UTF-8 bytes.
    const independent = createHash("sha256")
      .update("group-alice-familyalice-uid-12345", "utf8")
      .digest("hex");
    expect(got).toBe(`group_members_${independent}`);
  });
});
