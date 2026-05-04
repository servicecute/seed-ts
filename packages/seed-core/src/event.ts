/**
 * NDJSON event schema per spec §11.5. Every event is a single line of
 * JSON with the fixed top-level shape `{ ts, level, event, seed?, data }`.
 */

export type EventLevel = "info" | "warn" | "error";

export interface SeedEvent {
  ts: string; // RFC 3339 with millisecond precision, UTC
  level: EventLevel;
  event: string;
  seed?: string;
  data: Record<string, unknown>;
}

export interface EventEmitter {
  emit(event: SeedEvent): void;
}

/** NDJSON-on-stdout emitter — the spec's `--format=json` mode. */
export class StdoutNdjsonEmitter implements EventEmitter {
  emit(event: SeedEvent): void {
    process.stdout.write(JSON.stringify(event) + "\n");
  }
}

/**
 * Human-readable emitter for `--format=text` (§11.4). Mirrors errors
 * to stderr; suppresses ANSI when stdout isn't a TTY.
 */
export class TextEmitter implements EventEmitter {
  private readonly color: boolean;
  constructor(color: boolean = process.stdout.isTTY ?? false) {
    this.color = color;
  }
  emit(event: SeedEvent): void {
    const line = formatTextLine(event, this.color);
    if (event.level === "error") {
      process.stderr.write(line + "\n");
    }
    process.stdout.write(line + "\n");
  }
}

/** Test-friendly emitter that buffers events for assertion. */
export class CapturingEmitter implements EventEmitter {
  private readonly events: SeedEvent[] = [];
  emit(event: SeedEvent): void {
    this.events.push(event);
  }
  drain(): SeedEvent[] {
    return this.events.splice(0);
  }
}

function formatTextLine(e: SeedEvent, color: boolean): string {
  const lvl =
    e.level === "info" ? "INFO" : e.level === "warn" ? "WARN" : "ERROR";
  const colored = !color
    ? lvl
    : e.level === "info"
    ? `\x1b[32m${lvl}\x1b[0m`
    : e.level === "warn"
    ? `\x1b[33m${lvl}\x1b[0m`
    : `\x1b[31m${lvl}\x1b[0m`;
  const seed = e.seed ? ` seed=${e.seed}` : "";
  const detail = summariseData(e.data);
  return `${e.ts} [${colored}] ${e.event}${seed} ${detail}`;
}

function summariseData(data: Record<string, unknown>): string {
  const keys = [
    "verb",
    "backend",
    "scope_target",
    "applied_count",
    "skipped_count",
    "error_count",
    "duration_ms",
    "record_count",
    "reason",
    "error_code",
    "message",
    "transformer",
    "field",
    "path_key",
  ];
  const parts: string[] = [];
  for (const k of keys) {
    if (k in data) {
      const v = data[k];
      const s = typeof v === "string" ? v : JSON.stringify(v);
      parts.push(`${k}=${s}`);
    }
  }
  return parts.length > 0 ? parts.join(" ") : JSON.stringify(data);
}

/** Build an event with the spec's millisecond-precision UTC `ts`. */
export function makeEvent(
  level: EventLevel,
  event: string,
  data: Record<string, unknown>,
  seed?: string,
): SeedEvent {
  const e: SeedEvent = {
    ts: new Date().toISOString(),
    level,
    event,
    data,
  };
  if (seed) e.seed = seed;
  return e;
}
