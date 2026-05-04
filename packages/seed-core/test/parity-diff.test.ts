import { describe, expect, it } from "bun:test";
import {
  compareEventShapes,
  makeEvent,
  parseNdjson,
} from "../src/index.js";

describe("parseNdjson", () => {
  it("skips comments and blank lines", () => {
    const parsed = parseNdjson(
      "# comment\n\n{\"event\":\"x\",\"data\":{}}\n",
    );
    expect(parsed.length).toBe(1);
  });

  it("rejects malformed JSON with line context", () => {
    expect(() => parseNdjson("not-json")).toThrow(/line 1/);
  });
});

describe("compareEventShapes", () => {
  it("matches when names + data keys align", () => {
    const expected = parseNdjson(
      '{"event":"runner.starting","data":{"verb":"apply"}}\n' +
        '{"event":"seed.applied","data":{"record_count":3,"duration_ms":75}}',
    );
    const actual = [
      makeEvent("info", "runner.starting", { verb: "apply" }),
      makeEvent("info", "seed.applied", {
        record_count: 99,
        duration_ms: 1,
      }),
    ];
    expect(() => compareEventShapes(expected, actual)).not.toThrow();
  });

  it("flags extra data key in actual", () => {
    const expected = parseNdjson('{"event":"seed.applied","data":{"a":1}}');
    const actual = [makeEvent("info", "seed.applied", { a: 1, b: 2 })];
    expect(() => compareEventShapes(expected, actual)).toThrow(/only in actual/);
  });

  it("flags event-name mismatch", () => {
    const expected = parseNdjson('{"event":"runner.starting","data":{}}');
    const actual = [makeEvent("info", "runner.completed", {})];
    expect(() => compareEventShapes(expected, actual)).toThrow(/name mismatch/);
  });
});
