/**
 * `IdentityProvider` impl for Firebase Auth — wraps the
 * `firebase-admin` Node SDK so the seed runner can mint / lookup /
 * delete users via the Identity Toolkit Admin endpoints (proposed
 * spec §25).
 *
 * Convention shared with `cloud-firebase-admin` (Rust adapter):
 * - `auth/email-already-exists` → {@link IdentityError.alreadyExists}
 * - `auth/user-not-found`       → {@link IdentityError.notFound}
 *
 * Emulator support: `firebase-admin` auto-detects the
 * `FIREBASE_AUTH_EMULATOR_HOST` env var and routes to the emulator
 * without service-account credentials. Production needs a service-
 * account-credentialed `App` per the firebase-admin docs.
 */

import {
  type CreateIdentityRequest,
  type IdentityProvider,
  type IdentityRecord,
  IdentityError,
} from "@servicecute/seed-core";
import { type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";

export interface FirebaseAdminIdentityProviderOptions {
  /** Optional registry name for telemetry. Defaults to `"firebase"`. */
  name?: string;
  /**
   * Optional explicit Firebase Admin App. When omitted, the provider
   * uses the default app via `getAuth()`. Useful when an application
   * has multiple Firebase Apps initialised (multi-project) and the
   * seed runner needs a specific one.
   */
  app?: App;
}

/**
 * Provider-trait wrapper around `firebase-admin`'s Auth surface.
 *
 * ```ts
 * import { initializeApp } from "firebase-admin/app";
 * import { FirebaseAdminIdentityProvider } from "@servicecute/firestore-seed";
 *
 * const app = initializeApp({ projectId: "my-project" });
 * const provider = new FirebaseAdminIdentityProvider({ app });
 * config.identityProviders.register("firebase", provider);
 * ```
 */
export class FirebaseAdminIdentityProvider implements IdentityProvider {
  readonly name: string;
  private readonly auth: Auth;

  constructor(opts: FirebaseAdminIdentityProviderOptions = {}) {
    this.name = opts.name ?? "firebase";
    this.auth = opts.app ? getAuth(opts.app) : getAuth();
  }

  async createIdentity(req: CreateIdentityRequest): Promise<IdentityRecord> {
    try {
      const created = await this.auth.createUser({
        email: req.email,
        ...(req.password !== undefined ? { password: req.password } : {}),
        emailVerified: req.emailVerified,
        ...(req.displayName !== undefined
          ? { displayName: req.displayName }
          : {}),
        ...(req.phoneNumber !== undefined
          ? { phoneNumber: req.phoneNumber }
          : {}),
        disabled: req.disabled,
      });
      // Custom claims are set in a second call — the SDK's createUser
      // doesn't accept them in the same payload.
      if (Object.keys(req.customClaims).length > 0) {
        await this.auth.setCustomUserClaims(created.uid, req.customClaims);
      }
      return { uid: created.uid, email: created.email ?? req.email };
    } catch (e) {
      throw mapFirebaseError(this.name, req.email, e);
    }
  }

  async lookupByEmail(email: string): Promise<IdentityRecord | undefined> {
    try {
      const user = await this.auth.getUserByEmail(email);
      return { uid: user.uid, email: user.email ?? email };
    } catch (e) {
      const code = errorCode(e);
      if (code === "auth/user-not-found") return undefined;
      throw mapFirebaseError(this.name, email, e);
    }
  }

  async deleteIdentity(uid: string): Promise<void> {
    try {
      await this.auth.deleteUser(uid);
    } catch (e) {
      const code = errorCode(e);
      // §25.6: idempotent delete — already-gone is success.
      if (code === "auth/user-not-found") return;
      throw IdentityError.provider(this.name, (e as Error).message ?? String(e));
    }
  }
}

/** Read `e.code` defensively (firebase-admin errors are `FirebaseAuthError`). */
function errorCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function mapFirebaseError(
  providerName: string,
  email: string,
  err: unknown,
): IdentityError {
  const code = errorCode(err);
  const message = (err as Error).message ?? String(err);
  if (code === "auth/email-already-exists") {
    return IdentityError.alreadyExists(email);
  }
  if (code === "auth/user-not-found") {
    return IdentityError.notFound(email);
  }
  if (code === "auth/invalid-email" || code === "auth/invalid-password") {
    return IdentityError.invalidConfiguration(message);
  }
  return IdentityError.provider(providerName, message);
}
