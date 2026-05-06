import { describe, expect, it } from "bun:test";
import {
  type CreateIdentityRequest,
  type DbBackend,
  type DeleteResult,
  type IdentityBinding,
  type IdentityProvider,
  type IdentityRecord,
  type Lock,
  type LockClaim,
  type LockHolder,
  type LockVerb,
  type OwnedWrite,
  type Seed,
  type SeedAction,
  type Tracking,
  type TrackingEntry,
  type WriteRequest,
  type WriteResult,
  IdentityError,
  ScopedBackends,
  SeedConfig,
  SeedError,
  SeedRunner,
} from "../src/index.js";

// ────────────────── stub provider ──────────────────

class StubProvider implements IdentityProvider {
  readonly name: string;
  private state: IdentityRecord[] = [];
  private nextUid = 1;
  constructor(name = "stub") {
    this.name = name;
  }
  snapshot(): IdentityRecord[] {
    return this.state.slice();
  }
  async createIdentity(req: CreateIdentityRequest): Promise<IdentityRecord> {
    if (this.state.some((u) => u.email === req.email)) {
      throw IdentityError.alreadyExists(req.email);
    }
    const uid = `user-${this.nextUid++}`;
    const rec: IdentityRecord = { uid, email: req.email };
    this.state.push(rec);
    return rec;
  }
  async lookupByEmail(email: string): Promise<IdentityRecord | undefined> {
    return this.state.find((u) => u.email === email);
  }
  async deleteIdentity(uid: string): Promise<void> {
    this.state = this.state.filter((u) => u.uid !== uid);
  }
}

// ────────────────── stub backend ──────────────────

class MemoryTracking implements Tracking {
  private entries: TrackingEntry[] = [];
  async setup(): Promise<void> {}
  async upsert(entry: TrackingEntry): Promise<void> {
    this.entries = this.entries.filter((e) => e.name !== entry.name);
    this.entries.push(entry);
  }
  async get(name: string): Promise<TrackingEntry | undefined> {
    return this.entries.find((e) => e.name === name);
  }
  async remove(name: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.name !== name);
  }
  async list(): Promise<TrackingEntry[]> {
    return [...this.entries].sort((a, b) => a.name.localeCompare(b.name));
  }
}

class MemoryLock implements Lock {
  async setup(): Promise<void> {}
  async acquire(
    verb: LockVerb,
    holder: LockHolder,
    ttlMs: number,
  ): Promise<LockClaim> {
    return { verb, holder, claimedAt: new Date().toISOString(), ttlMs };
  }
  async heartbeat(): Promise<void> {}
  async release(): Promise<void> {}
  async current(): Promise<LockClaim | undefined> {
    return undefined;
  }
  async forceUnlock(): Promise<void> {}
}

interface MemoryState {
  records: Array<{ table: string; key: string; data: unknown }>;
  failWrites: boolean;
}

class MemoryBackend implements DbBackend {
  private readonly _tracking = new MemoryTracking();
  private readonly _lock = new MemoryLock();
  constructor(private readonly state: MemoryState) {}
  tracking(): Tracking {
    return this._tracking;
  }
  lock(): Lock {
    return this._lock;
  }
  async setup(): Promise<void> {}
  async upsertBatch(writes: WriteRequest[]): Promise<WriteResult> {
    if (this.state.failWrites) {
      throw SeedError.coded("E_DATABASE_UNREACHABLE", "armed for failure");
    }
    const paths: string[] = [];
    for (const w of writes) {
      paths.push(`${w.table}:${w.key}`);
      this.state.records = this.state.records.filter(
        (r) => r.table !== w.table || r.key !== w.key,
      );
      this.state.records.push({ table: w.table, key: w.key, data: w.data });
    }
    paths.sort();
    return { pathsTouched: [...new Set(paths)], recordCount: writes.length };
  }
  async deletePaths(paths: string[]): Promise<DeleteResult> {
    const deleted: string[] = [];
    const missing: string[] = [];
    for (const p of paths) {
      const [t, k] = p.split(":", 2);
      if (!t || !k) {
        missing.push(p);
        continue;
      }
      const before = this.state.records.length;
      this.state.records = this.state.records.filter(
        (r) => r.table !== t || r.key !== k,
      );
      if (this.state.records.length < before) deleted.push(p);
      else missing.push(p);
    }
    return { deleted, missing };
  }
  async recordExists(table: string, key: string): Promise<boolean> {
    return this.state.records.some((r) => r.table === table && r.key === key);
  }
  async findUniqueConflicts(): Promise<string[]> {
    return [];
  }
  async findKeyByField(): Promise<string | undefined> {
    return undefined;
  }
  name(): string {
    return "memory";
  }
  async scopeTarget(): Promise<string | undefined> {
    return undefined;
  }
}

// ────────────────── seed action ──────────────────

class FixtureAction implements SeedAction {
  constructor(private readonly records: OwnedWrite[]) {}
  async produce(): Promise<OwnedWrite[]> {
    return this.records.map((r) => ({
      table: r.table,
      key: r.key,
      data: structuredClone(r.data),
    }));
  }
}

// ────────────────── helpers ──────────────────

function userSeedWith(bindings: Record<string, IdentityBinding>): Seed {
  return {
    name: "demo-users",
    scope: ["development"],
    dependsOn: [],
    requires: [],
    requiresSchemas: {},
    identities: bindings,
    keyHash: "sha256:test",
  };
}

function userRecord(key: string, email: string): OwnedWrite {
  return {
    table: "users",
    key,
    data: { email, owner_uid: null },
  };
}

function binding(
  provider: string,
  reqs: CreateIdentityRequest[],
  strategy: "skipIfEmailExists" | "failIfEmailExists" = "skipIfEmailExists",
  keyFromUid = false,
): IdentityBinding {
  return {
    provider,
    source: { kind: "inline", requests: reqs },
    uidTargets: ["/owner_uid"],
    matchField: "/email",
    keyFromUid,
    upsertStrategy: strategy,
  };
}

function reqOf(email: string): CreateIdentityRequest {
  return {
    email,
    password: "x",
    emailVerified: false,
    disabled: false,
    customClaims: {},
    params: null,
  };
}

function buildRunner(
  state: MemoryState,
  provider: StubProvider,
  seed: Seed,
  action: FixtureAction | undefined,
): SeedRunner<MemoryBackend> {
  const backends = new ScopedBackends<MemoryBackend>();
  backends.register("development", async () => new MemoryBackend(state));
  const config = new SeedConfig({
    backends,
    scopeTarget: "development",
  });
  config.seeds.register("demo-users", seed);
  if (action) config.actions.register("demo-users", action);
  config.identityProviders.register("stub", provider);
  return new SeedRunner(config);
}

// ────────────────── tests ──────────────────

describe("SeedRunner identity binding (§25)", () => {
  it("patches uidTargets with the minted uid", async () => {
    const state: MemoryState = { records: [], failWrites: false };
    const provider = new StubProvider();
    const seed = userSeedWith({
      users: binding("stub", [
        reqOf("ada@example.com"),
        reqOf("linus@example.com"),
      ]),
    });
    const action = new FixtureAction([
      userRecord("ada", "ada@example.com"),
      userRecord("linus", "linus@example.com"),
    ]);
    const runner = buildRunner(state, provider, seed, action);
    await runner.apply(["demo-users"]);

    expect(state.records.length).toBe(2);
    for (const r of state.records) {
      const uid = (r.data as Record<string, unknown>)["owner_uid"];
      expect(typeof uid).toBe("string");
      expect((uid as string).startsWith("user-")).toBe(true);
    }
    expect(provider.snapshot().length).toBe(2);
  });

  it("skip-if-exists reuses an existing identity", async () => {
    const state: MemoryState = { records: [], failWrites: false };
    const provider = new StubProvider();
    const pre = await provider.createIdentity({
      email: "ada@example.com",
      emailVerified: false,
      disabled: false,
      customClaims: {},
      params: null,
    });
    const seed = userSeedWith({
      users: binding("stub", [reqOf("ada@example.com")]),
    });
    const action = new FixtureAction([userRecord("ada", "ada@example.com")]);
    const runner = buildRunner(state, provider, seed, action);
    await runner.apply(["demo-users"]);

    expect(provider.snapshot().length).toBe(1);
    const owner = (state.records[0]!.data as Record<string, unknown>)[
      "owner_uid"
    ];
    expect(owner).toBe(pre.uid);
  });

  it("fail-if-exists raises E_IDENTITY_FAILED", async () => {
    const state: MemoryState = { records: [], failWrites: false };
    const provider = new StubProvider();
    await provider.createIdentity({
      email: "ada@example.com",
      emailVerified: false,
      disabled: false,
      customClaims: {},
      params: null,
    });
    const seed = userSeedWith({
      users: binding("stub", [reqOf("ada@example.com")], "failIfEmailExists"),
    });
    const action = new FixtureAction([userRecord("ada", "ada@example.com")]);
    const runner = buildRunner(state, provider, seed, action);
    await expect(runner.apply(["demo-users"])).rejects.toThrow(
      /E_IDENTITY_FAILED/,
    );
  });

  it("unregistered provider raises E_IDENTITY_FAILED", async () => {
    const state: MemoryState = { records: [], failWrites: false };
    const provider = new StubProvider();
    const seed = userSeedWith({
      users: binding("missing-provider", [reqOf("ada@example.com")]),
    });
    const action = new FixtureAction([userRecord("ada", "ada@example.com")]);
    const runner = buildRunner(state, provider, seed, action);
    await expect(runner.apply(["demo-users"])).rejects.toThrow(
      /missing-provider/,
    );
  });

  it("rolls back created identities on data-write failure", async () => {
    const state: MemoryState = { records: [], failWrites: true };
    const provider = new StubProvider();
    const seed = userSeedWith({
      users: binding("stub", [reqOf("ada@example.com")]),
    });
    const action = new FixtureAction([userRecord("ada", "ada@example.com")]);
    const runner = buildRunner(state, provider, seed, action);
    await expect(runner.apply(["demo-users"])).rejects.toThrow(
      /E_DATABASE_UNREACHABLE/,
    );
    expect(provider.snapshot().length).toBe(0);
  });

  it("reset deletes recorded identities", async () => {
    const state: MemoryState = { records: [], failWrites: false };
    const provider = new StubProvider();
    const seed = userSeedWith({
      users: binding("stub", [reqOf("ada@example.com")]),
    });
    const action = new FixtureAction([userRecord("ada", "ada@example.com")]);
    const runner = buildRunner(state, provider, seed, action);
    await runner.apply(["demo-users"]);
    expect(provider.snapshot().length).toBe(1);

    await runner.reset(["demo-users"], false, true);
    expect(provider.snapshot().length).toBe(0);
  });

  it("keyFromUid replaces OwnedWrite.key with the minted uid", async () => {
    const state: MemoryState = { records: [], failWrites: false };
    const provider = new StubProvider();
    const seed = userSeedWith({
      users: binding(
        "stub",
        [reqOf("ada@example.com")],
        "skipIfEmailExists",
        true, // keyFromUid
      ),
    });
    // Action emits the email as the placeholder key — runner rewrites.
    const action = new FixtureAction([
      userRecord("ada@example.com", "ada@example.com"),
    ]);
    const runner = buildRunner(state, provider, seed, action);
    await runner.apply(["demo-users"]);
    const stored = state.records[0]!;
    expect(stored.key).toMatch(/^user-/);
    expect(stored.key).not.toBe("ada@example.com");
  });
});
