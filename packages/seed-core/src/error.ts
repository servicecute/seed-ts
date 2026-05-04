/**
 * Stable error codes per spec §11.5.2 / §17.9. Each code maps to an
 * exit code via {@link exitCodeFor} (§11.3).
 */
export const ErrorCodes = [
  "E_SCOPE_VIOLATION",
  "E_DRIFT_REFUSED",
  "E_CONSTRAINT_UNIQUE",
  "E_CONSTRAINT_NOT_NULL",
  "E_CONSTRAINT_TYPE",
  "E_REF_MISSING",
  "E_RESET_RESTRICTED",
  "E_RESET_FK_HELD",
  "E_DATABASE_UNREACHABLE",
  "E_TRACKING_FAILED",
  "E_TRANSFORMER_MISSING",
  "E_TRANSFORMER_FAILED",
  "E_SCHEMA_VERSION_MISMATCH",
  "E_SCHEMA_NOT_FOUND",
  "E_RUNNER_LOCKED",
  "E_GENERATOR_TIMEOUT",
  "E_GENERATOR_FAILED",
  "E_GENERATOR_BUDGET_EXCEEDED",
  "E_GENERATOR_NOT_FOUND",
  "E_ORPHANED_ENTRIES",
  "E_INTERNAL",
] as const;
export type ErrorCode = (typeof ErrorCodes)[number];

/**
 * Map a {@link SeedError} (or just an `ErrorCode`) to the spec's
 * exit-code table (§11.3 + §11.5.2):
 * - 0 = success
 * - 1 = user error
 * - 2 = runtime error
 * - 3 = drift refused
 */
export function exitCodeFor(code: ErrorCode | undefined): number {
  if (!code) return 2;
  switch (code) {
    case "E_DRIFT_REFUSED":
      return 3;
    case "E_SCOPE_VIOLATION":
    case "E_TRANSFORMER_MISSING":
    case "E_SCHEMA_VERSION_MISMATCH":
    case "E_SCHEMA_NOT_FOUND":
    case "E_RUNNER_LOCKED":
    case "E_ORPHANED_ENTRIES":
    case "E_GENERATOR_BUDGET_EXCEEDED":
    case "E_GENERATOR_NOT_FOUND":
      return 1;
    default:
      return 2;
  }
}

export class SeedError extends Error {
  readonly code: ErrorCode | undefined;
  override readonly cause?: unknown;

  constructor(message: string, code?: ErrorCode, cause?: unknown) {
    super(message);
    this.name = "SeedError";
    this.code = code;
    this.cause = cause;
  }

  static coded(code: ErrorCode, message: string, cause?: unknown): SeedError {
    return new SeedError(`${code}: ${message}`, code, cause);
  }
}
