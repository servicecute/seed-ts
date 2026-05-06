/**
 * Identity provider seam (proposed spec §25).
 *
 * Bridges seeded data to the auth system that owns user identities.
 * When a seed writes user records to Firestore/SurrealDB but the
 * service authenticates via Firebase Auth or a custom auth service,
 * the seeded records reference uids that don't exist on the auth
 * side. This module gives seeds a way to declare identities they
 * own — the runner mints them through an {@link IdentityProvider}
 * before the data write and tears them down on reset.
 *
 * Mirrors `lib_seed_core::identity` byte-for-byte (event names,
 * trait surface, error semantics) per spec §25.7 cross-language
 * parity rules.
 */

import { SeedError } from "./error.js";
import { Registry } from "./registry.js";

/**
 * Provider seam — implemented by user-supplied adapters that wrap
 * Firebase Admin SDK, srv-surrealdb-auth client, Auth0, etc. The TS
 * package does not ship adapter implementations (mirrors the
 * `LlmProvider` pattern).
 */
export interface IdentityProvider {
  /** Display name for telemetry. Lower-snake-case. */
  readonly name: string;

  /**
   * Mint a new identity. Idempotency is the *caller's*
   * responsibility — the runner calls {@link lookupByEmail} first
   * when the binding's `upsertStrategy` is `"skipIfEmailExists"`.
   */
  createIdentity(req: CreateIdentityRequest): Promise<IdentityRecord>;

  /**
   * Resolve an existing identity by email. Returns `undefined`
   * when the email is unused. Used by the runner for idempotent
   * applies.
   */
  lookupByEmail(email: string): Promise<IdentityRecord | undefined>;

  /**
   * Tear down an identity. Called during seed reset / prune AFTER
   * the data write is gone. Implementors SHOULD treat
   * "already deleted" as success — re-running shouldn't fail.
   */
  deleteIdentity(uid: string): Promise<void>;
}

/**
 * Common-surface fields recognised by every provider. Provider-
 * specific knobs go through {@link CreateIdentityRequest.params}
 * (Firebase `photoUrl`, surreal-auth provider override, MFA
 * prefs, …).
 */
export interface CreateIdentityRequest {
  email: string;
  /** `undefined` means "create without a password" rather than
   * "use a default". */
  password?: string;
  /** §25 default `false`. Most providers gate password-reset and
   * email-link login on this flag. */
  emailVerified: boolean;
  displayName?: string;
  phoneNumber?: string;
  /** `true` blocks sign-in without removing the record. */
  disabled: boolean;
  /** JWT custom claims. Empty object = no claims set. */
  customClaims: Record<string, unknown>;
  /** Opaque per-provider knobs. */
  params: unknown;
}

/** What the provider returns. */
export interface IdentityRecord {
  uid: string;
  email: string;
}

/**
 * Per-seed declaration that one batch of records is paired with
 * auth-side identities. Mirrors the Rust `IdentityBinding`.
 */
export interface IdentityBinding {
  /** Name registered in the IdentityProviderRegistry. */
  provider: string;
  /** Where identity inputs come from. */
  source: IdentitySource;
  /**
   * JSON pointers (RFC 6901) into each data record where the
   * minted uid is written before the upsert. Multiple targets
   * cover records with denormalised role-id mirrors (`/id`,
   * `/customer/id`, `/roles/customer/id`). Missing intermediate
   * paths are silent no-ops.
   */
  uidTargets: string[];
  /**
   * JSON pointer into each data record whose value the runner
   * matches against {@link CreateIdentityRequest.email} to find
   * which records belong to which identity. Defaults to `/email`.
   */
  matchField: string;
  /**
   * When `true`, the runner ALSO replaces each matching record's
   * `OwnedWrite.key` with the minted uid before the upsert (§25.8).
   * Use this when the data backend treats the doc key as the auth
   * uid (Firebase Auth on Firestore is the canonical case).
   */
  keyFromUid: boolean;
  /** Strategy when the email is already registered upstream. */
  upsertStrategy: UpsertStrategy;
}

export type IdentitySource =
  | { kind: "inline"; requests: CreateIdentityRequest[] }
  /**
   * Identities derived from a generator-backed batch on the same
   * seed. Reserved for a future spec version — runner currently
   * raises `E_IDENTITY_FAILED` if a seed declares this source.
   */
  | { kind: "fromBatch"; batch: string; transformer: string };

export type UpsertStrategy = "skipIfEmailExists" | "failIfEmailExists";

/** Default `match_field`. */
export const DEFAULT_MATCH_FIELD = "/email";

/**
 * Tracked identity record stored alongside `paths_touched` in a
 * seed's tracking entry. Used by reset to walk the identities later.
 */
export interface TrackedIdentity {
  /** Provider registry name — same string as
   * {@link IdentityBinding.provider}. */
  provider: string;
  /** Minted uid. */
  uid: string;
  /** Email captured at apply time (diagnostic; never used as a
   * lookup key during reset). */
  email: string;
  /** Which IdentityBinding this came from (the key in
   * `Seed.identities`). */
  binding: string;
}

/**
 * Registry of `name → provider` (e.g. `"firebase" → impl`). Lives
 * on `SeedConfig` alongside `generators` and `actions`. Empty
 * registry + no `Seed.identities` declarations = the whole
 * identity path is a no-op.
 */
export type IdentityProviderRegistry = Registry<IdentityProvider>;

/**
 * Set the JSON pointer `pointer` to `value` inside `target`.
 * Missing intermediate keys are a silent no-op (mirrors the Rust
 * `set_pointer` tolerance — lets one binding declare `uid_targets`
 * spanning all role sub-blocks even though each persona has only
 * a subset).
 *
 * Throws when an intermediate value exists but isn't an object —
 * that's a real type error.
 */
export function setJsonPointer(
  target: unknown,
  pointer: string,
  value: unknown,
): void {
  if (pointer === "") {
    throw new Error(
      "setJsonPointer: empty pointer would require replacing the root, not supported",
    );
  }
  if (!pointer.startsWith("/")) {
    throw new Error(`setJsonPointer: pointer ${JSON.stringify(pointer)} must start with '/'`);
  }
  const segments = pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  const last = segments.pop()!;
  let cursor: unknown = target;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
      throw new Error(
        `setJsonPointer: intermediate value at ${JSON.stringify(seg)} is not an object`,
      );
    }
    const next = (cursor as Record<string, unknown>)[seg];
    if (next === undefined) {
      // Silent no-op — the leaf simply doesn't apply to this record.
      return;
    }
    cursor = next;
  }
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
    throw new Error(
      `setJsonPointer: parent of leaf ${JSON.stringify(last)} is not an object`,
    );
  }
  (cursor as Record<string, unknown>)[last] = value;
}

/** Read a JSON pointer; returns `undefined` for any miss. */
export function getJsonPointer(target: unknown, pointer: string): unknown {
  if (pointer === "") return target;
  if (!pointer.startsWith("/")) return undefined;
  const segments = pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cursor: unknown = target;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[seg];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

/**
 * Surface error variants emitted by adapter impls. Maps to
 * `E_IDENTITY_FAILED` at the runner boundary. Following the Rust
 * convention, adapters MUST substring-match `EMAIL_EXISTS` and
 * `USER_NOT_FOUND` against the underlying provider's error
 * messages — both Firebase Identity Toolkit and srv-surrealdb-auth
 * emit these strings verbatim.
 */
export type IdentityErrorKind =
  | { kind: "alreadyExists"; email: string }
  | { kind: "notFound"; uid: string }
  | { kind: "provider"; provider: string; message: string }
  | { kind: "invalidConfiguration"; message: string }
  | { kind: "transport"; message: string };

export class IdentityError extends Error {
  readonly variant: IdentityErrorKind;
  constructor(variant: IdentityErrorKind) {
    super(IdentityError.formatMessage(variant));
    this.name = "IdentityError";
    this.variant = variant;
  }
  static alreadyExists(email: string): IdentityError {
    return new IdentityError({ kind: "alreadyExists", email });
  }
  static notFound(uid: string): IdentityError {
    return new IdentityError({ kind: "notFound", uid });
  }
  static provider(provider: string, message: string): IdentityError {
    return new IdentityError({ kind: "provider", provider, message });
  }
  static invalidConfiguration(message: string): IdentityError {
    return new IdentityError({ kind: "invalidConfiguration", message });
  }
  static transport(message: string): IdentityError {
    return new IdentityError({ kind: "transport", message });
  }
  /** Re-raise this as a `SeedError(E_IDENTITY_FAILED)` with seed/binding context. */
  toSeedError(seedName: string, binding: string, email: string): SeedError {
    return SeedError.coded(
      "E_IDENTITY_FAILED",
      `seed ${JSON.stringify(seedName)} binding ${JSON.stringify(binding)}: provider ${JSON.stringify((this.variant as { provider?: string }).provider ?? "unknown")} on email ${JSON.stringify(email)}: ${this.message}`,
      this,
    );
  }
  private static formatMessage(v: IdentityErrorKind): string {
    switch (v.kind) {
      case "alreadyExists":
        return `identity already exists for email ${v.email}`;
      case "notFound":
        return `identity not found: ${v.uid}`;
      case "provider":
        return `provider ${v.provider} rejected request: ${v.message}`;
      case "invalidConfiguration":
        return `invalid configuration: ${v.message}`;
      case "transport":
        return `transport: ${v.message}`;
    }
  }
}
