import { describe, expect, it } from "bun:test";
import {
  registryFromJson,
  registryToJson,
  Registry,
  validateRecord,
  type SchemaEntry,
} from "../src/index.js";

const usersSchema: SchemaEntry = {
  name: "users",
  version: "1",
  source: "code",
  backend: { surrealdb: { table: "users", mode: "schemafull" } },
  schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      email: { type: "string", format: "email" },
      role: { enum: ["user", "admin"] },
    },
    required: ["email", "role"],
  },
};

describe("validateRecord", () => {
  it("passes a valid record", () => {
    expect(() =>
      validateRecord(usersSchema, { email: "alice@example.com", role: "user" }),
    ).not.toThrow();
  });

  it("flags missing required field", () => {
    expect(() =>
      validateRecord(usersSchema, { email: "alice@example.com" }),
    ).toThrow(/E_CONSTRAINT_TYPE/);
  });

  it("flags enum violation", () => {
    expect(() =>
      validateRecord(usersSchema, {
        email: "alice@example.com",
        role: "wizard",
      }),
    ).toThrow(/E_CONSTRAINT_TYPE/);
  });
});

describe("SchemaRegistry round-trip", () => {
  it("preserves entries through to_json / from_json", () => {
    const r = new Registry<SchemaEntry>();
    r.register("users", usersSchema);
    const raw = registryToJson(r);
    const r2 = registryFromJson(raw);
    const restored = r2.lookup("users")!;
    expect(restored.version).toBe("1");
    expect(restored.backend.surrealdb?.table).toBe("users");
    expect(restored.source).toBe("file"); // resets on round-trip per spec
  });
});
