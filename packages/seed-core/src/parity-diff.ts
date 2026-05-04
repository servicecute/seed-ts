import type { SeedEvent } from "./event.js";

/**
 * Parse a textual NDJSON file (one event per line, blank lines and
 * lines starting with `#` skipped) into the runtime expected event
 * sequence (spec §11.5.4).
 */
export function parseNdjson(input: string): unknown[] {
  const out: unknown[] = [];
  const lines = input.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`line ${i + 1}: not JSON: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * Compare expected and actual event sequences. Spec §11.5.4 mandates
 * shape equivalence: same event names in order + same data field key
 * sets. Values within `data` are NOT compared (`duration_ms`, `ts`
 * always differ).
 */
export function compareEventShapes(
  expected: unknown[],
  actual: SeedEvent[],
): void {
  if (expected.length !== actual.length) {
    throw new Error(
      `event count mismatch: expected ${expected.length} events, got ${actual.length}`,
    );
  }
  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i] as Record<string, unknown>;
    const act = actual[i]!;
    const expEvent = typeof exp["event"] === "string" ? exp["event"] : undefined;
    if (!expEvent) {
      throw new Error(`expected event #${i}: missing \`event\` field`);
    }
    if (expEvent !== act.event) {
      throw new Error(
        `event #${i}: name mismatch — expected ${JSON.stringify(expEvent)}, got ${JSON.stringify(act.event)}`,
      );
    }
    const expKeys = dataKeys(exp["data"]);
    const actKeys = dataKeys(act.data);
    const onlyExpected = [...expKeys].filter((k) => !actKeys.has(k));
    const onlyActual = [...actKeys].filter((k) => !expKeys.has(k));
    if (onlyExpected.length > 0 || onlyActual.length > 0) {
      throw new Error(
        `event #${i} (${act.event}): data key mismatch — only in expected: ${JSON.stringify(onlyExpected)}; only in actual: ${JSON.stringify(onlyActual)}`,
      );
    }
  }
}

function dataKeys(v: unknown): Set<string> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return new Set();
  return new Set(Object.keys(v as Record<string, unknown>));
}
