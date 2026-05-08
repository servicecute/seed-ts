import { SeedError } from "./error.js";

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * Generic named-key registry per spec §4. Explicit registration only;
 * no auto-discovery. Names match `[a-zA-Z][a-zA-Z0-9_-]*` (spec §4.1
 * v0.6.1). Lowercase kebab-case is the SHOULD-level convention for
 * human-named entries (seeds, transformers, generators, identity
 * providers); the schema registry uses camelCase / snake_case
 * collection names that match the underlying database's wire form,
 * which the runner's `record.table` lookup resolves byte-for-byte.
 * Duplicates error rather than silently overwrite.
 */
export class Registry<T> {
  private readonly entries = new Map<string, T>();

  register(name: string, entry: T): this {
    if (!NAME_PATTERN.test(name)) {
      throw new SeedError(
        `registry name ${JSON.stringify(name)} must match [a-zA-Z][a-zA-Z0-9_-]*`,
      );
    }
    if (this.entries.has(name)) {
      throw new SeedError(
        `registry already has entry named ${JSON.stringify(name)}`,
      );
    }
    this.entries.set(name, entry);
    return this;
  }

  lookup(name: string): T | undefined {
    return this.entries.get(name);
  }

  names(): string[] {
    return Array.from(this.entries.keys()).sort();
  }

  size(): number {
    return this.entries.size;
  }
}
