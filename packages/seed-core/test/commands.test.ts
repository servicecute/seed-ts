import { describe, expect, it, mock } from "bun:test";
import { parseArgvForTest } from "../src/commands.js";

// Re-export the internal parseArgv for testing via a thin wrapper
// added to commands.ts (see below). We test the parsing logic directly
// without needing a live runner.

describe("parseArgv", () => {
  it("apply --all", () => {
    const cmd = parseArgvForTest(["apply", "--all"]);
    expect(cmd).toMatchObject({ kind: "apply", all: true, names: [], force: false, dryRun: false });
  });

  it("apply names", () => {
    const cmd = parseArgvForTest(["apply", "baseline-users", "baseline-workspaces"]);
    expect(cmd).toMatchObject({ kind: "apply", all: false, names: ["baseline-users", "baseline-workspaces"] });
  });

  it("apply --force --scope staging", () => {
    const cmd = parseArgvForTest(["apply", "--all", "--force", "--scope", "staging"]);
    expect(cmd).toMatchObject({ kind: "apply", all: true, force: true, scope: "staging" });
  });

  it("reset --all --sudo --cascade", () => {
    const cmd = parseArgvForTest(["reset", "--all", "--sudo", "--cascade", "--yes"]);
    expect(cmd).toMatchObject({ kind: "reset", all: true, sudo: true, cascade: true, yes: true });
  });

  it("status", () => {
    expect(parseArgvForTest(["status"])).toMatchObject({ kind: "status" });
  });

  it("list", () => {
    expect(parseArgvForTest(["list"])).toMatchObject({ kind: "list" });
  });

  it("validate names", () => {
    const cmd = parseArgvForTest(["validate", "baseline-users"]);
    expect(cmd).toMatchObject({ kind: "validate", names: ["baseline-users"] });
  });

  it("export-registry", () => {
    expect(parseArgvForTest(["export-registry"])).toMatchObject({ kind: "exportRegistry" });
  });

  it("unknown verb returns undefined", () => {
    expect(parseArgvForTest(["unknown-verb"])).toBeUndefined();
  });

  it("empty argv returns undefined", () => {
    expect(parseArgvForTest([])).toBeUndefined();
  });
});
